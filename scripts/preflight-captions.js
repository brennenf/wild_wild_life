const REQUIRED_KEYS = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY'];

function main() {
  let failed = false;

  for (const key of REQUIRED_KEYS) {
    const value = process.env[key];
    if (!value || !value.trim()) {
      console.error(`Missing ${key}.`);
      failed = true;
    } else {
      const masked = `${value.slice(0, 4)}...${value.slice(-4)}`;
      console.log(`${key} is set (${masked}).`);
    }
  }

  if (failed) process.exit(1);
}

main();
