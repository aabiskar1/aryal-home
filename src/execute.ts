const instruction = process.argv.slice(2).join(' ').trim();
if (instruction.length === 0) {
	console.error(
		JSON.stringify({outcome: 'invalid_instruction', reason: 'missing_instruction', exitCode: 2}),
	);
	process.exitCode = 2;
} else {
	// Catch configuration-dependent imports too: startup errors must not expose exception details.
	try {
		const {runExecutionCli, formatExecutionCliResult} = await import('./cli/execution.js');
		const result = await runExecutionCli(instruction);
		console.log(formatExecutionCliResult(result));
		process.exitCode = result.exitCode;
	} catch {
		console.error(
			JSON.stringify({outcome: 'unexpected_error', reason: 'startup_failed', exitCode: 1}),
		);
		process.exitCode = 1;
	}
}
