import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('analisador', Path(__file__).parents[1]/'services/analisar_job.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

class Regras(unittest.TestCase):
    def derivado(self, tipo, media, cnae='0141-5/01'):
        e = next(e for e in a.ELEMENTOS if e['id'] == tipo)
        return a._calcular_derivado(e, [{'id':'faturamento','dados':{'media':media}}], {'cnae_principal':cnae})

    def test_limites(self):
        self.assertTrue(self.derivado('fastpass',200_000_000).startswith('Inconclusivo'))
        self.assertTrue(self.derivado('fastpass',200_000_001).startswith('Sim'))
        self.assertTrue(self.derivado('finap',50_000_000).startswith('Não'))
        self.assertTrue(self.derivado('finap',50_000_001).startswith('Sim'))
        self.assertTrue(self.derivado('finap',50_000_001,'9999-9/99').startswith('Não'))
        self.assertTrue(self.derivado('supply',30_000_000).startswith('Sim'))

    def test_media_e_somente_leitura(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp)/'B - Documentos'/'1 - Contábil'/'5 - ECF';d.mkdir(parents=True)
            for ano,valor in [(2024,'100.000.000,00'),(2025,'200.000.000,00'),(2026,'900.000.000,00')]:
                (d/f'{ano}.txt').write_text(f'TOTAL DO ARQUIVO: {valor}')
            before={str(p):p.read_bytes() for p in d.iterdir()}
            e=next(e for e in a.ELEMENTOS if e['id']=='faturamento')
            result=a._proc_faturamento(tmp,e,{})
            self.assertEqual(result['dados']['media'],150_000_000)
            self.assertEqual(len(result['dados']['por_ano']),3)
            self.assertEqual(len(result['dados']['evidencias']),3)
            self.assertEqual(before,{str(p):p.read_bytes() for p in d.iterdir()})
            (d/'duplicado2025.txt').write_text('TOTAL DO ARQUIVO: 300.000.000,00')
            self.assertIsNone(a._proc_faturamento(tmp,e,{})['dados']['media'])

    def test_transacao(self):
        e=next(e for e in a.ELEMENTOS if e['id']=='regularize')
        for valor,esperado in [('600.000,00',False),('600.000,01',True)]:
            with patch.object(a,'candidatos',return_value=['x.pdf']), patch.object(a,'extrair_texto',return_value=f'capacidade de pagamento\nValor total da dívida na PGFN e RFB: R$ {valor}'):
                self.assertEqual(a._proc_regularize('',e,{})['dados']['dentro'],esperado)

    def test_family(self):
        e=next(e for e in a.ELEMENTOS if e['id']=='socios')
        texto='CNPJ: 11.111.111/0001-11\nSócios e Administradores\n123.456.789-00 MARIA SILVA\n22.222.222/0001-22 EMPRESA SOCIA\nPendências\n333.333.333-33 TERCEIRO'
        with patch.object(a,'_varrer_pasta',return_value=['fiscal.pdf']),patch.object(a,'extrair_texto',return_value=texto):
            r=a._proc_qsa('',e,{})
            self.assertEqual([x['tipo'] for x in r['dados']['socios']],['CPF','CNPJ'])
            self.assertEqual(len(r['dados']['evidencias']),2)
            self.assertIs(r['dados']['eh_perfil'], False)

    def test_family_todos_cpf_e_sem_socios(self):
        e=next(e for e in a.ELEMENTOS if e['id']=='socios')
        for texto, esperado in [
            ('Sócios e Administradores\n123.456.789-00 MARIA SILVA\n987.654.321-00 JOAO SILVA', True),
            ('Sócios e Administradores\n22.222.222/0001-22 EMPRESA SOCIA', False),
            ('Sócios e Administradores\nNome ilegível', None),
            ('CNPJ: 11.111.111/0001-11', None),
        ]:
            with self.subTest(texto=texto), patch.object(a,'_varrer_pasta',return_value=['fiscal.pdf']), patch.object(a,'extrair_texto',return_value=texto):
                r=a._proc_qsa('',e,{})
                self.assertIs(r['dados']['eh_perfil'], esperado)

    def test_family_cnpj_em_outro_arquivo(self):
        e=next(e for e in a.ELEMENTOS if e['id']=='socios')
        textos={'a': 'Sócios e Administradores\n123.456.789-00 MARIA SILVA',
                'b': 'Sócios e Administradores\n22.222.222/0001-22 EMPRESA SOCIA'}
        with patch.object(a,'_varrer_pasta',return_value=list(textos)), patch.object(a,'extrair_texto',side_effect=textos.get):
            r=a._proc_qsa('',e,{})
            self.assertIs(r['dados']['eh_perfil'], False)
            self.assertEqual(r['arquivos'], ['a','b'])

    def test_simples_historico(self):
        e=next(e for e in a.ELEMENTOS if e['id']=='simples_nacional')
        t='Situação no Simples Nacional: NÃO OPTANTE\nPeríodos anteriores no Simples Nacional\n01/01/2020 a 31/12/2022'
        with patch.object(a,'candidatos',return_value=['simples.pdf']),patch.object(a,'extrair_texto',return_value=t):
            self.assertEqual(a._proc_simples('',e,{})['dados']['anos_optante'],[2020,2021,2022])


class Robustez(unittest.TestCase):
    def elem(self,id): return next(x for x in a.ELEMENTOS if x['id']==id)

    def test_filial_nao_vira_matriz(self):
        self.assertEqual(a._bloco_matriz('NUMERO DE INSCRICAO\n11.111.111/0002-22\nFILIAL\nDATA DE ABERTURA 20/08/2024'),'')
        self.assertEqual(a._bloco_matriz('NUMERO DE INSCRICAO\n11.111.111/0001-11\nDATA DE ABERTURA 01/01/2000'),'')

    def test_conflito_matriz(self):
        texts = {'a':'NUMERO DE INSCRICAO\nMATRIZ\nDATA DE ABERTURA 01/01/2000',
                 'b':'NUMERO DE INSCRICAO\nMATRIZ\nDATA DE ABERTURA 02/01/2000'}
        with patch.object(a,'candidatos',return_value=iter(texts)), patch.object(a,'extrair_texto',side_effect=texts.get):
            self.assertEqual(a._proc_data_abertura('',self.elem('data_abertura'),{})['status'],'inconclusivo')

    def test_fiscal_nao_extrai_certificado_ou_certidao_como_socio(self):
        text='CNPJ do certificado: 99.999.999/0001-99\nSócios e Administradores\n123.456.789-00 NOME EXEMPLO DIRETOR REGULAR\nCertidão Emitida ______\nCNPJ: 11.111.111/0001-11\nDiagnóstico Fiscal\n987.654.321-00 OUTRO'
        with patch.object(a,'_varrer_pasta',return_value=['x']),patch.object(a,'extrair_texto',return_value=text):
            socios=a._proc_qsa('',self.elem('socios'),{})['dados']['socios']
            self.assertEqual(len(socios),1)
            self.assertEqual(socios[0]['nome'],'NOME EXEMPLO')

    def test_simples_nao_inclui_simei_emissao_ou_evento_futuro(self):
        text='Consulta 01/01/2020 01/01/2026\nSituação no Simples Nacional: NÃO optante\nOpções pelo Simples Nacional em Períodos Anteriores\n01/01/2018 31/12/2019\nEnquadramentos no SIMEI em Períodos Anteriores\n01/01/2020 31/12/2021\nEventos Futuros (Simples Nacional)\n01/01/2027 31/12/2028'
        with patch.object(a,'candidatos',return_value=['x']),patch.object(a,'extrair_texto',return_value=text):
            r=a._proc_simples('',self.elem('simples_nacional'),{})
            self.assertEqual(r['dados']['anos_optante'],[2018,2019])

    def test_limite_transacao_nao_soma_contencioso(self):
        t='capacidade de pagamento\nValor total da dívida na PGFN e RFB: R$ 500.000,00\nValor em contencioso administrativo: R$ 900.000,00'
        with patch.object(a,'candidatos',return_value=['x']),patch.object(a,'extrair_texto',return_value=t):
            self.assertFalse(a._proc_regularize('',self.elem('regularize'),{})['dados']['dentro'])

    def test_divergencia_pgfn_inconclusiva(self):
        texts={x:f'capacidade de pagamento\nValor total da dívida na PGFN e RFB: R$ {v}' for x,v in [('x','500.000,00'),('y','900.000,00')]}
        with patch.object(a,'candidatos',return_value=iter(texts)),patch.object(a,'extrair_texto',side_effect=texts.get):
            self.assertEqual(a._proc_regularize('',self.elem('regularize'),{})['status'],'inconclusivo')

    def test_coluna_media_e_nao_soma(self):
        from unittest.mock import MagicMock
        sh=MagicMock();sh.title='Dados';sh.values=iter([('ANO','SOMA VALOR ORIGINAL','MÉDIA (÷ DOCS. MENSAIS)','STATUS'),('2025',44000000,4000000,'ACIMA DO LIMIAR')])
        wb=MagicMock();wb.__iter__.return_value=iter([sh])
        with patch.object(a,'_varrer_pasta',return_value=['perfil.xlsx']),patch('openpyxl.load_workbook',return_value=wb):
            r=a._proc_perfil('',self.elem('perfil'),{})
            self.assertEqual(r['dados']['anos'][0]['media'],4000000)

    def test_busca_pasta_exata_e_acento(self):
        with tempfile.TemporaryDirectory() as tmp:
            certo=Path(tmp)/'B - Documentos'/'1 - Contabil'/'5 - ECF';certo.mkdir(parents=True);(certo/'2025.txt').write_text('x')
            errado=Path(tmp)/'B - Documentos'/'11 - Contabil'/'5 - ECF';errado.mkdir(parents=True);(errado/'2025.txt').write_text('x')
            achados=list(a._varrer_pasta(tmp,['B - Documentos','1 - Contábil','5 - ECF'],{'.txt'}))
            self.assertEqual(len(achados),1)

    def test_cache_rele_arquivo_atualizado(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'x.txt';p.write_text('antigo')
            self.assertEqual(a.extrair_texto(str(p)),'antigo')
            p.write_text('novo conteudo')
            self.assertEqual(a.extrair_texto(str(p)),'novo conteudo')


    def test_ano_nao_vem_da_emissao_e_conflitos_nao_sao_chutados(self):
        self.assertIsNone(a._ano_do_arquivo('relatorio.txt','Emitido em 01/10/2026'))
        self.assertIsNone(a._ano_do_arquivo('receita2024.txt','Ano calendário 2025'))
        self.assertEqual(a._ano_do_arquivo('receita.txt','Ano calendário 2025'),'2025')

    def test_arrecadacao_nao_e_faturamento(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp)/'B - Documentos'/'1 - Contábil'/'5 - ECF';d.mkdir(parents=True)
            (d/'2025.txt').write_text('DARF Período Apuração 2025 TOTAL DO ARQUIVO 900.000.000,00')
            self.assertIsNone(a._proc_faturamento(tmp,self.elem('faturamento'),{})['dados'].get('media'))


    def test_filial_no_nome_nunca_abre(self):
        with patch.object(a.os, 'stat') as stat, patch.object(a, '_extrair_texto_raw') as ler:
            self.assertEqual(a.extrair_texto('/origem/CNPJ FiLiAl (52).pdf'), '')
            stat.assert_not_called()
            ler.assert_not_called()
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp)/'B - Documentos'/'5 - Cliente'/'16 - CNPJ'
            d.mkdir(parents=True)
            for nome in ['CNPJ MATRIZ.pdf','CNPJ FILIAL.pdf','CNPJ filial (52).pdf']:
                (d/nome).write_bytes(b'')
            achados=list(a._varrer_pasta(tmp,['B - Documentos','5 - Cliente','16 - CNPJ'],{'.pdf'}))
            self.assertEqual([Path(x).name for x in achados],['CNPJ MATRIZ.pdf'])


    def test_consolidado_blocos_e_exclusao_sped(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp)/'B - Documentos'/'1 - Contábil'/'5 - ECF';d.mkdir(parents=True)
            texto = 'TOTAL CONSOLIDADO (SOMA): 1.230,00\nFAT MEDIO: 307,50\n'
            for ano,total,tipo in [(2025,'200,00','ARQUIVO'),(2024,'100,00','ARQUIVO'),(2026,'900,00','ANO PIS/COFINS'),(2023,'30,00','ANO PIS/COFINS')]:
                texto += f'ARQUIVO: SPEDECF-origem-{ano}.txt\nANO: {ano}\nLINHAS SOMADAS:\nLinha 1 Valor 9.999,00\nTOTAL DO {tipo}: {total}\n'
            (d/'consolidado.txt').write_text(texto)
            (d/'SpEdECF-2025.txt').write_text('TOTAL DO ARQUIVO: 999.999,00')
            original=a._extrair_texto_raw
            with patch.object(a,'_extrair_texto_raw', wraps=original) as ler:
                r=a._proc_faturamento(tmp,self.elem('faturamento'),{})
                self.assertTrue(all('sped' not in Path(c.args[0]).name.lower() for c in ler.call_args_list))
            self.assertEqual(r['dados']['por_ano'],{'2023':30,'2024':100,'2025':200,'2026':900})
            self.assertEqual(r['dados']['media'],110)
            self.assertEqual(r['dados']['anos_media'],['2023','2024','2025'])
            self.assertEqual(len(r['dados']['evidencias']),4)

    def test_bloco_sem_total_nao_usa_consolidado(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp)/'B - Documentos'/'1 - Contábil'/'5 - ECF';d.mkdir(parents=True)
            (d/'faturamento.txt').write_text('ANO: 2025\nTOTAL CONSOLIDADO: 9.000,00')
            r=a._proc_faturamento(tmp,self.elem('faturamento'),{})
            self.assertEqual(r['status'],'sem_dado')
            self.assertFalse(r['valor'])

    def test_contrato_exige_contrato_no_nome(self):
        e = self.elem('contrato_existe')
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)/'A - Contrato'/'1 - Contrato Studio'; d.mkdir(parents=True)
            (d/'Acordo de Confidencialidade.pdf').write_bytes(b'')
            (d/'Procuracao.pdf').write_bytes(b'')
            self.assertFalse(a._proc_existencia(tmp, e, {})['valor'])            # só NDA/outros: não conta
            (d/'CONTRATO Studio.pdf').write_bytes(b'')
            r = a._proc_existencia(tmp, e, {})
            self.assertEqual(r['valor'], 'Sim — CONTRATO Studio.pdf')
            self.assertEqual(len(r['arquivos']), 1)
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)/'A - Contrato'/'1 - Contrato Studio'; d.mkdir(parents=True)
            (d/'contrato assinado.pdf').write_bytes(b'')
            self.assertTrue(a._proc_existencia(tmp, e, {})['valor'])             # minúsculas também
            (d/'contrato assinado.pdf').rename(d/'Contrato.docx')
            self.assertFalse(a._proc_existencia(tmp, e, {})['valor'])            # só PDF

    def test_sem_contrato_gera_alerta_no_checklist(self):
        self.assertTrue(a._build_checklist([{'id':'contrato_existe','valor':''}])[0]['alerta'])
        self.assertFalse(a._build_checklist([{'id':'contrato_existe','valor':'Sim — Contrato.pdf'}])[0]['alerta'])


    # ── Simples Nacional: períodos com datas completas e períodos NÃO optante ─────────
    CONSULTA_SIMPLES = (
        'Data da consulta: 27/10/2026 15:33:03\nIdentificação do Contribuinte - CNPJ Matriz\n'
        'Situação Atual\nSituação no Simples Nacional: NÃO optante pelo Simples Nacional\n'
        'Situação no SIMEI: NÃO enquadrado no SIMEI\n'
        'Períodos Anteriores\nOpções pelo Simples Nacional em Períodos Anteriores:\nData Inicial Data Final Detalhamento\n'
        '01/01/2017 31/12/2017 Excluída por Ato Administrativo praticado pelo ente ARACAJU-SE\n'
        '29/07/2015 31/12/2016 Excluída por Ato Administrativo praticado pelo ente ARACAJU-SE\n'
        'Enquadramentos no SIMEI em Períodos Anteriores: Não Existem\n'
        'Eventos Futuros (Simples Nacional)\nNão Existem\n')

    def simples(self, texto, ctx=None):
        with patch.object(a,'candidatos',return_value=['s.pdf']),patch.object(a,'extrair_texto',return_value=texto):
            return a._proc_simples('',self.elem('simples_nacional'),ctx if ctx is not None else {})

    def test_simples_mostra_datas_completas_e_detalhamento(self):
        r = self.simples(self.CONSULTA_SIMPLES)
        linhas = r['valor'].splitlines()
        # ordem cronológica, com data inicial e final completas + detalhamento (as infos do print)
        i = linhas.index('Períodos como optante do Simples Nacional:')
        self.assertEqual(linhas[i+1], '  • 29/07/2015 a 31/12/2016 — Excluída por Ato Administrativo praticado pelo ente ARACAJU-SE')
        self.assertEqual(linhas[i+2], '  • 01/01/2017 a 31/12/2017 — Excluída por Ato Administrativo praticado pelo ente ARACAJU-SE')
        self.assertNotIn('Anos documentados', r['valor'])
        self.assertEqual(r['dados']['anos_optante'], [2015, 2016, 2017])           # compatível com o que já existia
        self.assertEqual(r['dados']['periodos_optante'], [{'inicio':'29/07/2015','fim':'31/12/2017'}])  # contíguos unidos

    def test_simples_periodos_nao_optante_com_abertura(self):
        r = self.simples(self.CONSULTA_SIMPLES, {'data_abertura': '10/02/2012'})
        self.assertEqual(r['dados']['periodos_nao_optante'], [
            {'inicio':'10/02/2012','fim':'28/07/2015'}, {'inicio':'01/01/2018','fim':'27/10/2026'}])
        self.assertIn('  • 10/02/2012 a 28/07/2015', r['valor'])
        self.assertIn('  • 01/01/2018 a 27/10/2026 (data da consulta)', r['valor'])

    def test_simples_sem_abertura_nao_inventa_inicio(self):
        r = self.simples(self.CONSULTA_SIMPLES)
        self.assertEqual(r['dados']['periodos_nao_optante'], [{'inicio':'01/01/2018','fim':'27/10/2026'}])
        self.assertIn('antes de 29/07/2015 (data de abertura não identificada', r['valor'])

    def test_simples_lacuna_entre_periodos(self):
        t = ('Data da consulta: 01/03/2026\nSituação no Simples Nacional: NÃO optante pelo Simples Nacional\n'
             'Opções pelo Simples Nacional em Períodos Anteriores:\n'
             '01/01/2021 30/06/2022 Excluída por Opção do Contribuinte\n'
             '01/03/2018 31/12/2019 Excluída por Opção do Contribuinte\n'
             'Eventos Futuros (Simples Nacional)\n')
        r = self.simples(t, {'data_abertura': '05/05/2015'})
        self.assertEqual(r['dados']['periodos_optante'], [{'inicio':'01/03/2018','fim':'31/12/2019'},{'inicio':'01/01/2021','fim':'30/06/2022'}])
        self.assertEqual(r['dados']['periodos_nao_optante'], [
            {'inicio':'05/05/2015','fim':'28/02/2018'}, {'inicio':'01/01/2020','fim':'31/12/2020'}, {'inicio':'01/07/2022','fim':'01/03/2026'}])

    def test_simples_nunca_optante_e_historico_desconhecido(self):
        nunca = ('Data da consulta: 01/03/2026\nSituação no Simples Nacional: NÃO optante pelo Simples Nacional\n'
                 'Opções pelo Simples Nacional em Períodos Anteriores: Não Existem\n')
        r = self.simples(nunca, {'data_abertura': '05/05/2015'})
        self.assertEqual(r['dados']['periodos_nao_optante'], [{'inicio':'05/05/2015','fim':'01/03/2026'}])
        # sem informação de histórico: nada é inferido (nem como optante, nem como não optante)
        r = self.simples('Data da consulta: 01/03/2026\nSituação no Simples Nacional: NÃO optante pelo Simples Nacional\n')
        self.assertEqual(r['dados']['periodos_optante'], []); self.assertEqual(r['dados']['periodos_nao_optante'], [])
        self.assertIn('não identificado', r['valor'])

    def test_simples_optante_atual_nao_gera_lacuna_final(self):
        t = ('Data da consulta: 01/03/2026\nSituação no Simples Nacional: Optante pelo Simples Nacional\n'
             'Optante desde 01/01/2020\n')
        r = self.simples(t, {'data_abertura': '05/05/2015'})
        self.assertEqual(r['dados']['periodos_nao_optante'], [{'inicio':'05/05/2015','fim':'31/12/2019'}])
        self.assertTrue(r['dados']['atual_optante'])

    def test_data_abertura_da_matriz_chega_ao_simples(self):
        ctx = {}
        card = 'NUMERO DE INSCRICAO\n11.111.111/0001-11 MATRIZ\nDATA DE ABERTURA 10/02/2012'
        with patch.object(a,'candidatos',return_value=iter(['c.pdf'])),patch.object(a,'extrair_texto',return_value=card):
            a._proc_data_abertura('',self.elem('data_abertura'),ctx)
        self.assertEqual(ctx.get('data_abertura'), '10/02/2012')
        r = self.simples(self.CONSULTA_SIMPLES, ctx)
        self.assertEqual(r['dados']['data_abertura_considerada'], '10/02/2012')


if __name__=='__main__': unittest.main()
