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

## Regerar o pacote

```bash
npm run package
```

O arquivo é sobrescrito nesta mesma pasta.
