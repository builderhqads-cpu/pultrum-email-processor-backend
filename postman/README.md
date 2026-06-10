# Postman

- Collection: `pultrum-mail-processor.postman_collection.json`

## Variaveis

- `baseUrl`: `http://localhost:3000`
- `mailboxId`: UUID de um registro em `Mailbox` (para `POST /mailboxes/:id/sync`)
- `emailId`: ID de um registro em `EmailMessage` (para `GET /emails/:id`)
- `orderId`: ID de um registro em `TransportOrder` (para `GET /orders/:id` e POSTs manuais)
