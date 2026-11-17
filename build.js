const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('=== Lampa Sync Plugin Build ===');

const srcPath = path.join(__dirname, 'sync.js');
console.log('[1/2] Reading source file:', srcPath);
const code = fs.readFileSync(srcPath, 'utf8');

console.log('[2/2] Validating JavaScript syntax...');
try {
    new vm.Script(code);
    console.log('      Syntax validation SUCCESSFUL!');
} catch (err) {
    console.error('      Syntax validation FAILED:', err.message);
    process.exit(1);
}

console.log('=== Build completed successfully! ===\n');
