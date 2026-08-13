# Segurança

Este repositório não deve receber tokens, senhas, chaves privadas, arquivos `.env` ou credenciais OAuth.

## Relatar uma vulnerabilidade

Não abra uma issue pública com detalhes exploráveis. Contate o proprietário do projeto de forma privada e inclua apenas os passos mínimos para reproduzir o problema.

## Arquitetura

- O navegador contém somente a chave publicável do Supabase.
- Tokens do ClickUp e Google Drive ficam exclusivamente em Secrets das Edge Functions.
- A função exige sessão válida, conta autorizada, origem conhecida e data atual.
- O banco utiliza Row Level Security e um registro idempotente para impedir duplicações.
