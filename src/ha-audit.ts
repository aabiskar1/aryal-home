import {runHaAuditCli} from './cli/ha-audit.js';

const result = await runHaAuditCli(process.argv.slice(2));
console.log(result.output);
process.exitCode = result.exitCode;
