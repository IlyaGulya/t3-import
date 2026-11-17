#!/usr/bin/env node
import { runNativeCli } from "./cli.js";

await runNativeCli(process.argv.slice(2));
