# Pacote de deploy

**Arquivo:** `vantus-atendimento-squarecloud.zip`

Pronto para enviar na SquareCloud. Contém o bot completo + `squarecloud.app` na raiz +
`LEIA-ME-PRIMEIRO.txt` com o passo a passo. Não contém `node_modules`, `.env`, `data/` nem testes.

## Antes de enviar

Cadastre as variáveis de ambiente no painel da SquareCloud:

```
DISCORD_TOKEN=seu_token
GUILD_ID=id_do_servidor
DB_PATH=./data/vantus.sqlite
TIMEZONE=America/Sao_Paulo
AUTO_REGISTER_COMMANDS=true
```

## Depois de iniciar

```
/setup criar_cargos:true
/diagnostico
/painel publicar painel:Ambos
```

Guia detalhado: [../docs/01-instalacao-squarecloud.md](../docs/01-instalacao-squarecloud.md)

## Publicar pela API (sem painel)

```bash
SQUARECLOUD_TOKEN=xxxx SQUARECLOUD_APP_ID=yyyy npm run deploy:squarecloud
```

Envia este zip, reinicia a aplicação e, com `--reset-data`, apaga o banco antes do envio.
Todo push na `main` também publica, via `.github/workflows/deploy-squarecloud.yml`
(basta cadastrar os secrets `SQUARECLOUD_TOKEN` e `SQUARECLOUD_APP_ID` no GitHub).

## Regerar o pacote

```bash
npm run package
```

O arquivo é sobrescrito nesta mesma pasta.
