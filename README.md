# hack-leaseweb-exemplo-app

App de exemplo de uma PME (encomendas, faturas em S3, base de dados, fila, segredos e cache) usada na demo do
projeto [hack-leaseweb](https://github.com/guilhermepferreira0429/hack-leaseweb), InfraHack Leaseweb, 20/11/2026.

Começa presa à AWS (simulada com o LocalStack). O **migrador de código** do hack-leaseweb abre aqui pull requests
para a app passar a usar os serviços abertos na Leaseweb (MinIO, PostgreSQL, RabbitMQ, OpenBao, Valkey).
Os PR só mudam configuração e nunca trazem segredos. O merge é decidido por uma pessoa.

O código vive no monorepo do hack-leaseweb (`code/exemplo-app`); este repo é uma cópia para os PR da demo.
Licença Apache 2.0.
