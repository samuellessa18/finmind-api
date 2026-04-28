#!/usr/bin/env node

/**
 * Valida a estrutura do backend para garantir que não há paths duplicados
 * Roda sem dependências externas
 */

const fs = require('fs');
const path = require('path');

const ERRORS = [];
const WARNINGS = [];
const SUCCESS = [];

function validateFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Procura por patterns perigosos
    if (content.includes("require('./src/") || content.includes('require("./src/')) {
      ERRORS.push(`❌ ${filePath} — contém require('./src/... (path duplicado)`);
    }
    
    if (content.includes("from './src/") || content.includes('from "./src/')) {
      ERRORS.push(`❌ ${filePath} — contém import de './src/... (path duplicado)`);
    }
    
    // Verifica se tem require('../') corretos
    if (content.includes("require('../") || content.includes('require("../')) {
      SUCCESS.push(`✅ ${filePath} — imports relativos corretos`);
    }
  } catch (error) {
    console.warn(`⚠️ Não consegui ler ${filePath}:`, error.message);
  }
}

function validateDirectory(dirPath) {
  try {
    const files = fs.readdirSync(dirPath);
    
    files.forEach(file => {
      if (file === 'node_modules' || file.startsWith('.')) return;
      
      const fullPath = path.join(dirPath, file);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        validateDirectory(fullPath);
      } else if (file.endsWith('.js')) {
        validateFile(fullPath);
      }
    });
  } catch (error) {
    console.warn(`⚠️ Erro ao ler diretório ${dirPath}:`, error.message);
  }
}

console.log('🔍 Validando estrutura do backend...\n');

// Valida server.js
console.log('📋 Arquivo principal (server.js):');
validateFile(path.join(__dirname, 'server.js'));

// Valida src/
console.log('\n📁 Arquivos em src/:');
validateDirectory(path.join(__dirname, 'src'));

console.log('\n' + '='.repeat(60));
console.log('RESULTADO DA VALIDAÇÃO');
console.log('='.repeat(60));

if (ERRORS.length > 0) {
  console.log(`\n❌ ERROS ENCONTRADOS (${ERRORS.length}):\n`);
  ERRORS.forEach(err => console.log(err));
}

if (WARNINGS.length > 0) {
  console.log(`\n⚠️ AVISOS (${WARNINGS.length}):\n`);
  WARNINGS.forEach(warn => console.log(warn));
}

if (SUCCESS.length > 0) {
  console.log(`\n✅ VERIFICAÇÕES PASSADAS (${SUCCESS.length}):\n`);
  SUCCESS.slice(0, 5).forEach(s => console.log(s));
  if (SUCCESS.length > 5) {
    console.log(`... e mais ${SUCCESS.length - 5} verificações`);
  }
}

console.log('\n' + '='.repeat(60));
if (ERRORS.length === 0) {
  console.log('✅ Backend está pronto para deploy!');
  process.exit(0);
} else {
  console.log('❌ Corrija os erros acima antes de fazer deploy');
  process.exit(1);
}
