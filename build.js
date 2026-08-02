const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Read the .env file
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');

// Parse the .env file into an object
const envVars = envContent
  .split('\n')
  .filter(line => line.trim() !== '' && !line.startsWith('#'))
  .reduce((acc, line) => {
    const [key, ...value] = line.split('=');
    acc[key.trim()] = value.join('=').trim();
    return acc;
  }, {});

// Create a config file that will be embedded
const configContent = `// Auto-generated during build - DO NOT EDIT
module.exports = ${JSON.stringify(envVars, null, 2)};
`;

// Write the config file
fs.writeFileSync(path.join(__dirname, 'config', 'env.config.js'), configContent);

console.log('✅ Environment variables embedded into config/env.config.js');

// Run pkg to create the executable
console.log('🚀 Starting build process...');
try {
  // Create build directory if it doesn't exist
  if (!fs.existsSync('build')) {
    fs.mkdirSync('build');
  }
  
  // First package the app
  console.log('📦 Packaging the application...');
  execSync('npx pkg . --out-path build --targets node18-win-x64', { stdio: 'inherit' });
  
  // Rename the output file to backend.exe
  const platform = process.platform === 'win32' ? 'win' : 'linux';
  const arch = process.arch === 'x64' ? 'x64' : 'x86';
  const exeName = `back-${platform}-${arch}`;
  
  if (fs.existsSync(`build/${exeName}.exe`)) {
    fs.renameSync(`build/${exeName}.exe`, 'build/backend.exe');
  }
  
  console.log('✅ Build completed successfully!');
  console.log('📦 Executable created at: build/backend.exe');
  console.log('\nTo run the application, use:');
  console.log('  cd build');
  console.log('  .\backend.exe');
} catch (error) {
  console.error('❌ Build failed:');
  console.error(error.message);
  process.exit(1);
}
