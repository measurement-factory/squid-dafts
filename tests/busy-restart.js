/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

/* Tests HTTP proxy cache availability, consistency across hard restarts */

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import * as ConfigurationGenerator from "../src/test/ConfigGen";
import * as Http from "../src/http/Gadgets";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";

import assert from "assert";

const reRestart = "restart";
const reReconfigure = "reconfigure";
const reHarsh = "harsh";
const reSmooth = "smooth";
const reSmoothOrHarsh = "smooth-or-harsh";

Config.Recognize([
    {
        option: "dut-refresh-mode",
        type: "String",
        enum: [reRestart, reReconfigure],
        default: reRestart,
        description: "how to refresh Squid in the middle of a test\n" +
            `\t${reRestart} (stop Squid instance and start again; once)\n`+
            `\t${reReconfigure} (send SIGHUP, like "squid -k reconfigure" would; several times\n`,
    },
    {
        option: "dut-reconfiguration-mode",
        type: "String",
        enum: [reHarsh, reSmooth, reSmoothOrHarsh],
        default: reHarsh,
        description: `Squid 'reconfigure' directive setting (${reHarsh}, ${reSmooth}, ${reSmoothOrHarsh})\n` +
            `\tThis option requires --dut-refresh-mode set to ${reReconfigure}\n`,
    },
]);

/// whether transactions concurrent with instance refreshing events may fail
function ToleratingErrors()
{
    // for reSmoothOrHarsh, we currently assume that Squid will ultimately reconfigure in reSmooth mode
    return Config.dutRefreshMode() === reRestart || Config.dutRefreshMode() === reHarsh;
}

export default class MyTest extends Test {

    static Configurators() {
        const configGen = new ConfigurationGenerator.FlexibleConfigGen();

        configGen.bodySize(function *() {
            yield 0;
            yield Config.DefaultBodySize();
            yield Config.LargeBodySize();
        });

        configGen.dutRefreshMode(function *() {
            yield reRestart;
            yield reReconfigure;
        });

        configGen.dutReconfigurationMode(function *(cfg) {
            if (cfg.dutRefreshMode() === reReconfigure) {
                yield reHarsh;
                yield reSmooth;
                yield reSmoothOrHarsh;
            }
        });

        configGen.dutShutdownManner(function *(cfg) {
            // these shutdown "manners" may be interesting in all refreshMode()s
            yield 'gracefully';
            yield 'urgently';

            // uncatchable SIGKILL can only create problems for Squid if Squid
            // is restarted afterwords
            if (cfg.dutRefreshMode() === reRestart)
                yield 'immediately';
        });

        return configGen.generateConfigurators();
    }

    constructor() {
        super(...arguments);
        this._serverAddress = null; // origin server address
    }

    _configureDut(cfg) {
        cfg.workers(4);
        cfg.memoryCaching(false); // TODO: Make Configurable.
        cfg.diskCaching(true); // TODO: Make Configurable.
        // TODO: Test with a very small cache_dir as well.

        if (Config.dutRefreshMode() === reReconfigure)
            cfg.custom(`reconfiguration ${Config.dutReconfigurationMode()}`);
    }

    async run(/*testRun*/) {

        this._serverAddress = AddressPool.ReserveListeningAddress();

        // check that the cache is functioning
        await this._cacheOne(true);
        await this._validateOne(true);

        const keptBusy = this._keepProxyBusy();
        const keptValid = this._keepValidatingProxyCache();

        if (Config.dutRefreshMode() === reRestart) {
            await this.dut.restart();
        } else {
            for (let reconfigurations = 0; reconfigurations < 5; ++reconfigurations)
                await this.dut.reconfigureWithoutChanges(false);
        }
        this._restarted = true;

        await keptBusy;
        await keptValid;

        // check that the cache is still functioning
        await this._cacheOne(true);
        await this._validateOne(true);

        AddressPool.ReleaseListeningAddress(this._serverAddress);
    }

    // load-creating thread: cache responses until the restart thread is done
    async _keepProxyBusy() {
        await this.keepDoingOptionalTransactions(async () => this._cacheOne(false));
    }

    // weak validation thread: check hits until the restart thread is done
    async _keepValidatingProxyCache() {
        await this.keepDoingOptionalTransactions(async () => this._validateOne(false));
    }

    // optional transactions thread that runs until the restart thread is done
    async keepDoingOptionalTransactions(step) {
        let sequentialErrorsToReportMax = 10;
        let sequentialErrors = 0;
        while (!this._restarted) {
            try {
                await step();
                if (sequentialErrors >= sequentialErrorsToReportMax)
                    console.log("will report future optional transaction errors");
                sequentialErrors = 0;
            } catch (error) {
                if (!ToleratingErrors())
                    throw error;
                ++sequentialErrors;
                if (sequentialErrors <= sequentialErrorsToReportMax) {
                    console.log("ignoring optional transaction error:", error);
                    if (sequentialErrors === sequentialErrorsToReportMax)
                        console.log("will not report subsequent sequential optional transaction errors");
                }
            }
        }
    }

    // cache a single response (without validation)
    async _cacheOne(runningSolo) {
        if (runningSolo) {
            // make sure any winding down swapouts from previous concurrent
            // transactions do not interfere with our ability to cache
            await this.dut.finishCaching();
        }

        const resource = new Resource();
        resource.uri.address = this._serverAddress;
        resource.makeCachable();
        resource.finalize();

        const missHow = runningSolo ? "definitely" : "maybe";
        const missCase = new HttpTestCase(`${missHow} cache a response`);
        missCase.server().serve(resource);
        missCase.client().request.for(resource);
        if (runningSolo || !ToleratingErrors())
            missCase.addMissCheck();
        await missCase.run();

        if (runningSolo) {
            // successful caching includes making sure our miss swapout ends
            await this.dut.finishCaching();

            this._lastCachedResource = resource;
            this._lastCachedResponse = missCase.server().transaction().response;
        }
    }


    // validate that the last cached resource, if still cached, is not
    // corrupted and, in certain cases, that it is still cached
    async _validateOne(runningSolo) {
        assert(this._lastCachedResource);
        assert(this._lastCachedResponse);

        // There are two classes of allowed problems: I/O errors and misses.
        // * We may see I/O errors during restarts or harsh reconfiguration.
        const tolerateIoErrors = !runningSolo && ToleratingErrors();
        // * We may miss unless runningSolo: During smooth reconfiguration, we
        //   do not tolerate I/O errors, but we still cannot require a hit for
        //   our background _validateOne() transactions because concurrent
        //   background _cacheOne() transactions may purge old
        //   this._lastCachedResponse that our transactions are hitting.
        const tolerateMisses = !runningSolo;

        const hitHow = runningSolo ? "definitely" : "maybe";
        const hitCase = new HttpTestCase(`${hitHow} hit a cached response`);
        hitCase.client().request.for(this._lastCachedResource);
        hitCase.client().request.header.add("Cache-Control", "only-if-cached");

        hitCase.client().checks.add((client) => {
            const context = client.context;
            const retrieved = client.transaction().response;

            if (!runningSolo) {
                // tolerateMisses conditions here are guaranteed to be true,
                // but we spell them out anyway to distinguish classes of
                // allowed problems as documented when setting tolerateMisses.
                assert(tolerateMisses);

                if (tolerateIoErrors && (!retrieved || !retrieved.startLine)) {
                    context.log("no hit validation due to the lack of a valid response");
                    return;
                }

                const scode = retrieved.startLine.codeInteger();
                if (tolerateIoErrors && scode === undefined) {
                    context.log("no hit validation due to the lack of a valid response status code");
                    return;
                }
                if (tolerateMisses && scode !== 200) {
                    // If may miss, our only-if-cached request may cause a non-200 response.
                    context.log("no hit validation due to response status code:", scode);
                    return;
                }

                const nameRfr = Http.DaftFieldName("Response-From-Resource");
                if (tolerateMisses && !this._lastCachedResponse.header.has(nameRfr)) {
                    context.log("no hit validation due to missing header:", nameRfr);
                    return;
                }

                // XXX: What does "earlier" mean?! Resource paths are (or, to
                // be more precise, should be assumed to be) unique! Every
                // _cacheOne() creates a new Resource. We request
                // this._lastCachedResource that call created at some point.
                // This response must have the same resource ID. TODO: Delete
                // or re-explain the excuse/code below!
                //
                // we cannot get a 200 OK cache miss because hitCase has no
                // server, but we can get a response that was cached earlier
                const receivedResourceId = retrieved.header.value(nameRfr);
                if (this._lastCachedResource.id !== receivedResourceId) {
                    context.log("no hit validation due to a mismatching resource ID; wanted",
                        this._lastCachedResource.id, "but got", receivedResourceId);
                    return;
                }

                const cached = this._lastCachedResponse;
                assert.equal(!retrieved.body, !cached.body);
                if (tolerateIoErrors && cached.body && cached.body.whole().length > retrieved.body.whole().length) {
                    context.log("no hit validation due to response truncation; cached",
                        cached.body.whole().length, "but got", retrieved.body.whole().length);
                    return;
                }

                context.log("detected an optional hit; will validate");
            }

            Http.AssertForwardedMessage(
                this._lastCachedResponse,
                retrieved,
                "response");
        });

        await hitCase.run();
    }
}
