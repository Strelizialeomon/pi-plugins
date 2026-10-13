/**
 * Keep the logic out of the extension factory so it can be unit-tested
 * without Pi running. `index.ts` wires it to the ExtensionAPI.
 */
export function greeting(name: string): string {
	return `Hello, ${name}!`;
}
