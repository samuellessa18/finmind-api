'use strict';

// [CATEGORIAS] Fonte ÚNICA das categorias padronizadas (pt-BR) no backend.
// Consumida por server.js (validação de transações) e budgetRoutes (orçamento).
// Espelha financas-pessoais/src/constants/categories.ts (front).
const EXPENSE_CATEGORIES = [
  'Alimentação', 'Moradia', 'Transporte', 'Saúde', 'Educação', 'Lazer',
  'Compras', 'Assinaturas', 'Contas', 'Impostos', 'Seguros', 'Pets',
  'Viagens', 'Investimentos', 'Presentes', 'Doações', 'Cuidados Pessoais',
  'Vestuário', 'Tecnologia', 'Trabalho', 'Empréstimos',
  'Família', 'Emergências', 'Outros',
];
const INCOME_CATEGORIES = [
  'Salário', 'Freelance', 'Comissões', 'Investimentos', 'Aluguel',
  'Reembolsos', 'Prêmios', 'Vendas', 'Benefícios', 'Outros',
];
const CATEGORIES_BY_TYPE = { expense: EXPENSE_CATEGORIES, income: INCOME_CATEGORIES };

module.exports = { EXPENSE_CATEGORIES, INCOME_CATEGORIES, CATEGORIES_BY_TYPE };
