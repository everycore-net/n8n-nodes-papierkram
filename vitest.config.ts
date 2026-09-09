import { defineConfig } from 'vitest/config';

export default defineConfig({
	// n8n-workflow ships source maps that point at files it does not ship, and
	// Vite warns about every one of them. The warnings are about a dependency's
	// packaging, not about this package, and they bury the test output.
	logLevel: 'error',
	test: {
		include: ['test/**/*.test.ts'],
	},
});
