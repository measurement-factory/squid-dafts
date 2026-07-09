// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests DUT performance using pre-installed Web Polygraph binaries and a
// hard-coded Web Polygraph workload. This Polygraph wrapper is an experiment.

import assert from "assert";
import Config from "../src/misc/Config.js";
import Test from "../src/overlord/Test.js";
import { FlexibleConfigGen } from "../src/test/ConfigGen.js";
import { spawn } from "node:child_process";

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
        const server = this._runExe("../polygraph/server/server", "--version");
        const client = this._runExe("../polygraph/client/client", "--version");
        await Promise.all(server, client);
    }

    async runExe(exePath, args = [], options = {}) {
        // XXX: Add Promise.try?
        const context = new Context(exePath);
        return new Promise((resolve, reject) => {
            const child = spawn(exePath, args, {
                stdio: ["ignore", "pipe", "pipe"],
                ...options
            });

            child.on("error", (err) => {
                context.log("startup failure: %s", err);
                reject;
            });

            child.on("close", (exitCode) => {
                if (exitCode) {
                    context.log("execution failed with exit code %s", exitCode);
                    reject();
                }
                resolve();
            });

            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                context.log("stdout> %s", chunk);
            });

            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk) => {
                context.log("stderr> %s", chunk);
            });
        });
}

    }

}
