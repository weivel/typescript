#!/usr/bin/env node
import { bundleCommandLine } from "./command-line.js";

process.exitCode = await bundleCommandLine(process.argv.slice(2));
