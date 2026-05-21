// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import * as Http from "../src/http/Gadgets";
import assert from "assert";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";
import { FlexibleConfigGen } from "../src/test/ConfigGen";

// the highest worker ID we are using (via _workerListeningAddressFor() calls)
const WorkerIdMax = 2;
let CollapsedRequestsType = "{each:Maybe Number";
for (let i = 0; i < WorkerIdMax; ++i) {
    CollapsedRequestsType += `,${i + 1}:Maybe Number`;
}
CollapsedRequestsType += "}";

Config.Recognize([
    {
        option: "workers",
        type: "Number",
        default: WorkerIdMax.toString(),
        description: "the number of proxy SMP workers",
    },
    {
        // The miss transaction always goes through the first worker.
        // Collapsed requests go to the workers mapped by this option.
        // For example, to send 2 collapsed requests to each worker
        // but keep the third worker idle, use --collapsed-requests each:2,3:0
        option: "collapsed-requests",
        type: CollapsedRequestsType,
        default: "{each:2}",
        description: "the number of collapsed requests for each worker",
    },
    {
        option: "server-code",
        type: "Number",
        default: "200",
        description: "the server response code (200, 304 or 503)",
    },
    {
        option: "client-send-not-modified",
        type: "Boolean",
        description: "whether clients produce an IMS request (requesting a not-modifed resource)",
    },
    {
        option: "negative-caching",
        type: "Boolean",
        description: "turns on 503 responses negative caching mode",
    },
]);

export default class MyTest extends Test {

    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.workers(function *() {
            yield WorkerIdMax;
        });

        configGen.serverCode(function *(cfg) {
            yield 200;
            yield 304;
            yield 503;
        });

        configGen.clientSendNotModified(function *(cfg) {
            yield false;
            if (cfg.serverCode() === 200 || cfg.serverCode() === 304 )
                yield true;
        });

        configGen.negativeCaching(function *(cfg) {
            yield false;
            if (cfg.serverCode() === 503)
                yield true;
        });

        return configGen.generateConfigurators();
    }

    constructor() {
        super(...arguments);
        this._resource = null; // generated, cached, and updated by test cases
    }

    _configureDut(cfg) {
        cfg.workers(Config.workers()); // TODO: This should be the default.
        cfg.dedicatedWorkerPorts(Config.workers() > 1); // for simplicity sake; TODO: Do this by default.
        cfg.collapsedForwarding(true);
        cfg.memoryCaching(true);
        cfg.diskCaching(false);
        if (Config.negativeCaching())
            cfg.custom("negative_ttl 1 hour");

        this._workerListeningAddresses = cfg.workerListeningAddresses();
    }

    async run(/*testRun*/) {

        const defaultRequests = 'each' in Config.CollapsedRequests ?
            Config.CollapsedRequests.each : 0;

        let collapsedRequestsForWorker = Array(1 + Config.Workers).fill(defaultRequests);
        for (let workerLabel of Object.keys(Config.CollapsedRequests)) {
            if (workerLabel === "each") // handled above
                continue;
            assert(workerLabel > 0);
            assert(workerLabel <= WorkerLimit);
            assert(workerLabel <= Config.Workers); // a worker ID in --collapsed-requests list exceeded --workers value
            collapsedRequestsForWorker[workerLabel] = Config.CollapsedRequests[workerLabel];
        }

        const originAddress = AddressPool.ReserveListeningAddress();

        assert(!this._resource);
        this._resource = new Resource();
        this._resource.makeCachable();
        this._resource.uri.address = originAddress;
        this._resource.requireRevalidationOnEveryUse(true);
        this._resource.finalize();

        const initialResponse = await this._cacheCurrentResource();
        await this._checkCached(initialResponse);

        let testCase = new HttpTestCase('force a refresh miss that replaces the previously cached response');
        this._resource.modifyNow();
        this._resource.requireRevalidationOnEveryUse(false);
        testCase.server().serve(this._resource);
        if (Config.clientSendNotModified()) {
            testCase.client().request.conditions({ ims: this._resource.notModifiedSince() });
        }

        testCase.server().response.tag("second");
        testCase.server().response.startLine.code(Config.serverCode());

        let updatingClient = testCase.client();
        updatingClient.request.for(this._resource);
        updatingClient.nextHopAddress = this._workerListeningAddresses[1];
        this._clientsConfigured = 1; // the total number of clients configured so far

        // add clients for each worker; they should all collapse on updatingClient
        for (let worker = 1; worker <= Config.Workers; ++worker) {
            const isInitiator = (worker === 1);

            testCase.makeClients(collapsedRequestsForWorker[worker], (collapsedClient) => {
                collapsedClient.request.for(this._resource);
                if (Config.clientSendNotModified()) {
                    collapsedClient.request.conditions({ ims: this._resource.notModifiedSince() });
                }

                collapsedClient.nextHopAddress = this._workerListeningAddresses[worker];
                this._blockClient(collapsedClient, testCase);

                const updatingResponse = testCase.server().transaction().response;

                collapsedClient.checks.add(client => {

                    if (Config.clientSendNotModified()) {
                        if (Config.serverCode() === 200 && isInitiator) {
                            client.expectStatusCode(200);
                        } else { 
                            client.expectStatusCode(304);
                        }
                    } else if (Config.serverCode() === 503) {
                        if (Config.negativeCaching()) {
                            client.expectStatusCode(503);
                        } else if (isInitiator) {
                            client.expectStatusCode(503);
                        } else {
                            client.expectStatusCode(504); // Squid generates 504 after the collapsed client fails to connect directly
                        }
                    } else {
                        client.expectStatusCode(200);
                    }

                    const receivedResponse = client.transaction().response;
                    const receivedCode = receivedResponse.startLine.codeInteger() ;
                    if (Config.serverCode() === 503) {
                        if (Config.negativeCaching()) {
                            assert.equal(updatingResponse.tag(), receivedResponse.tag(), "updated X-Daft-Response-Tag");
                        } else if (isInitiator) {
                            assert.equal(updatingResponse.tag(), receivedResponse.tag(), "updated X-Daft-Response-Tag");
                        } else {
                            assert(receivedCode === 504); // Squid-generated 504 does not have tags
                        }
                    } else if (receivedCode === 200) {
                        assert.equal(updatingResponse.tag(), receivedResponse.tag(), "updated X-Daft-Response-Tag");
                    } else {
                        assert(receivedCode === 304);
                        if (isInitiator) {
                            assert.equal(updatingResponse.tag(), receivedResponse.tag(), "updated X-Daft-Response-Tag");
                        }
                        // else Squid-generated 304 does not have tags
                     }
                });
            });
        }

        this._blockServer(testCase);

        await testCase.run();

        AddressPool.ReleaseListeningAddress(originAddress);
    }

    async _cacheCurrentResource() {
        let testCase = new HttpTestCase('forward a cachable response');
        testCase.client().nextHopAddress = this._workerListeningAddresses[1];
        testCase.client().request.for(this._resource);
        testCase.server().serve(this._resource);
        testCase.server().response.tag("first");
        testCase.addMissCheck();

        await testCase.run();
        await this.dut.finishCaching();
        return testCase.server().transaction().response;
    }

    async _checkCached(response) {
        const rid = response.id();
        const testCase = new HttpTestCase(`check that the previous origin server response (${rid}) got cached`);
        testCase.client().nextHopAddress = this._workerListeningAddresses[2];
        testCase.client().request.for(this._resource);
        testCase.server().serve(this._resource);
        testCase.server().response.startLine.code(304);
        // This helps confirm that the original response was not purged.
        testCase.server().response.header.prohibitDaftMarkings(); // TODO: Do this by default on 304s.

        // Compared to `response`, a 304 response may have a slightly
        // different Date header, so we should not addHitCheck(response).
        testCase.client().checks.add(() => {
            Http.AssertRefreshHit(
               response,
               testCase.server().transaction().response,
               testCase.client().transaction().response);
        });

        await testCase.run();
    }

    _blockClient(hitClient, testCase) {
        const { event, eventDescription } = this._clientResumingEvent(testCase);
        hitClient.transaction().blockSendingUntil(event, eventDescription);
    }

    // returns { event, eventDescription } object
    _clientResumingEvent(testCase) {
        const event = this.dut.finishStagingRequests(this._resource.uri.path, this._clientsConfigured);
        this._clientsConfigured++;
        const eventDescription = "wait for the revalidation client request to reach the proxy";
        return { event, eventDescription };
    }

    _blockServer(testCase) {
        const { event, eventDescription } = this._serverResumingEvent(testCase);
        testCase.server().transaction().blockSendingUntil(event, eventDescription);
    }

    // returns { event, eventDescription } object
    _serverResumingEvent(testCase) {
        const event = this.dut.finishStagingRequests(this._resource.uri.path, testCase.clients().length);
        const eventDescription = "wait for all client requests to reach the proxy";
        return { event, eventDescription };
    }
}

