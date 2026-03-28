const REQUIRED_ENV = 'GEMINI_API_KEY';

function main() {
  const value = process.env[REQUIRED_ENV];

  if (!value || !value.trim()) {
    console.error(`Missing ${REQUIRED_ENV}.`);
    console.error('Set it before AI-enabled deploy commands, for example:');
    console.error('  export GEMINI_API_KEY="your_api_key_here"');
    process.exit(1);
  }

  const masked = `${value.slice(0, 4)}...${value.slice(-4)}`;
  console.log(`${REQUIRED_ENV} is set (${masked}).`);
}

main();
