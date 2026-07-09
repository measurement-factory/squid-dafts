// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests DUT performance using pre-installed Web Polygraph binaries and a
// hard-coded Web Polygraph workload. This Polygraph wrapper is an experiment.

import * as child_process from "node:child_process";
import * as Lifetime from "../src/misc/Lifetime.js";
import * as os from "node:os";
import assert from "assert";
import Config from "../src/misc/Config.js";
import Context from "../src/misc/Context.js";
import Test from "../src/overlord/Test.js";
import { FlexibleConfigGen } from "../src/test/ConfigGen.js";

Config.Recognize([
    {
        option: "workers",
        type: "Number",
        description: "the number of Squid worker processes",
    },
    {
        // A DELETE should have both immediate (i.e. before restart) and
        // lasting (i.e. after restart) effects. However, checking the effects
        // of DELETE before the restart may mask a problem with flushing
        // metadata to disk, so we do not want to always perform that check.
        option: "check-before-restart",
        type: "Boolean",
        description: "whether to check purging results before restarting Squid",
    },
    {
        option: "create-background-load",
        type: "Boolean",
        description: "whether to use background transactions to increase test pressure",
    },
]);

export default class MyTest extends Test {

    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.workers(function *() {
            yield 2;
        });

        return configGen.generateConfigurators();
    }

    _configureDut(cfg) {
        cfg.workers(Config.workers()); // TODO: This should be the default.
    }

    async run(/*testRun*/) {
        Lifetime.Extend(new Date(15*60*1000)); // XXX: 15 minutes may not match the workload!

        const serverContext = new Context("server", "");
        const server = this._runExe(serverContext, "/tmp/poly-exes/server", this._makeArgs(serverContext, [
            "--idle_tout", "30sec"
        ]));

        const clientContext = new Context("client", "");
        const proxyAuthority = Config.proxyAuthority();
        const client = this._runExe(clientContext, "/tmp/poly-exes/client", this._makeArgs(clientContext, [
            "--proxy", `${proxyAuthority.host}:${proxyAuthority.port}`
        ]));
        await Promise.all([server, client]);
    }

    _makeArgs(agentContext, extras = []) {
        return [
            "--config", "/usr/local/squid/etc/generic.pg", // XXX
            "--verb_lvl", "10",
            "--log", `${os.tmpdir()}/daft-generic-performance-polygraph-${agentContext.id}.log`,
            ...extras
        ];
    }

    async _runExe(context, exePath, args = [], options = {}) {
        // XXX: Add Promise.try?
        return new Promise((resolve, reject) => {
            const child = child_process.spawn(exePath, args, {
                stdio: ["ignore", "pipe", "pipe"],
                ...options
            });

            child.once("error", (err) => {
                context.log("startup failure: %s", err);
                reject();
            });

            child.once("close", (exitCode) => {
                if (exitCode) {
                    context.log("execution failed with exit code %s", exitCode);
                    reject();
                }
                resolve();
            });

            const logConsoleLines = (streamName, lines) => {
                lines.trim().split('\n').forEach(line => context.log(`${streamName}> ${line}`));
            };

            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => logConsoleLines("stdout", chunk));

            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk) => logConsoleLines("stderr", chunk));

            process.once("exit", () => {
                if (child.exitCode === null && child.signalCode === null && !child.killed) {
                    context.log("forcing child process termination due to imminent parent exit");
                    child.kill("SIGKILL");
                }
            });
        });
    }

}
