import assert from 'assert';

export const results = { passed: 0, failed: 0, skipped: 0 };

export async function test(name: string, fn: () => void | Promise<void>) {
    try {
        await fn();
        results.passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        results.failed++;
        const err = e as Error;
        const detail = err instanceof assert.AssertionError ? err.message : String(err?.stack || err).split('\n').slice(0, 6).join('\n');
        console.log(`  FAIL ${name}\n       ${detail.split('\n').join('\n       ')}`);
    }
}

export function skip(name: string, why: string) {
    results.skipped++;
    console.log(`  skip ${name} (${why})`);
}

export function done() {
    console.log(`\n  ${results.passed} passed, ${results.failed} failed${results.skipped ? `, ${results.skipped} skipped` : ''}`);
    process.exitCode = results.failed ? 1 : 0;
}
