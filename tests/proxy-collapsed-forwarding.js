/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

/* Tests whether an HTTP proxy caches a response
 * Parameters: [drop-Content-Length] [body size] */

import HttpTestCase from "../src/test/HttpCase";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import * as AddressPool from "../src/misc/AddressPool";
import { Must } from "../src/misc/Gadgets";
import assert from "assert";
import Test from "../src/test/Test";

const BasePort = Config.ProxyListeningAddress.port;
const Host = Config.ProxyListeningAddress.host;
const AddrLimit = 8;
let ProxyListeningAddresses = [];
for (let i = 0; i < AddrLimit; ++i) {
    ProxyListeningAddresses.push({host: Host, port: BasePort + i});
}

Config.Recognize([
    {
        option: "requests",
        type: "Number",
        default: "4",
        description: "simultaneous requests number (>1 && <="+AddrLimit,
    },
    {
        option: "workers",
        type: "Number",
        default: "4",
        description: "Squid workers number",
    },
]);

export default class MyTest extends Test {

    constructor(...args) {
        // XXX: We should not be writing constructors to configure a DUT.
        // TODO: Add virtual Test::configureDut() or a similar method.
        super(null, ...args); // no DUT for now
    }

    async run(/*testRun*/) {

    Must(Config.Requests > 1);

    // TODO: Remove args. Use Config directly instead.
    const args = {
        workers: Config.Workers,
        requests: Config.Requests
    };

    let resource = new Resource();
    resource.makeCachable();
    resource.uri.address = AddressPool.ReserveListeningAddress();
    resource.body = new Body(Gadgets.UniqueId("body-"));
    resource.finalize();

    const initiatorAddr = ProxyListeningAddresses[0];
    const smp = args.workers > 1;
    const collapseAddr = smp ? ProxyListeningAddresses[1] : ProxyListeningAddresses[0];

    // need this for pids checking for SMP
    let pids = [2];

    let collapseCase = new HttpTestCase('collapse on the existing transaction', collapseAddr);
    collapseCase.client().request.for(resource);
    collapseCase.client().nextHopAddress = collapseAddr;
    let requests = args.requests - 2;
    if (requests > 0) {
        for (let i = 2; i < args.workers; ++i) {
            pids.push(i+1);
            if (--requests === 0)
                break;
        }
        for (let clientId = 1; clientId <= requests; ++clientId) {
            const lastPid = pids[pids.length-1];
            pids.push(lastPid);

            let client = collapseCase.addClient();
            const lastAddress = ProxyListeningAddresses[args.workers - 1]; // XXX: Why that? Why does not it change with the request/worker?
            client.nextHopAddress = lastAddress;
        }

    }
    collapseCase.check(() => {
        let pidIdx = 0;
        for (let client of collapseCase.clients()) {
            assert(client.transaction().response, "Proxy must send a response");
            const collapseStatus = client.transaction().response.startLine.statusNumber();
            if (smp) {
                const pid = client.transaction().response.proxyPid();
                assert.equal(pid, pids[pidIdx], "expected worker pid");
                pidIdx++;
            }
            const collapseTag = client.transaction().response.tag();
            assert.equal(collapseStatus, 200, "expected response status code 200");
            assert.equal(collapseTag, "first", "Squid collapsed worker X-Daft-Response-Tag");
        }
    });


    let initiatorCase = new HttpTestCase('initiate a transaction', initiatorAddr);
    initiatorCase.client().request.for(resource);
    initiatorCase.check(() => {
        assert(initiatorCase.client().transaction().response, "Proxy must send a response");
        initiatorCase.expectStatusCode(200);
        //const initiatorPid = initiatorCase.client().transaction().response.proxyPid();
        const initiatorTag = initiatorCase.client().transaction().response.tag();
        assert.equal(initiatorTag, "first", "Squid collapsing initiator worker X-Daft-Response-Tag");
        let responseBody = initiatorCase.client().transaction().response.body.whole();
        assert.equal(responseBody, resource.body.whole(), "Served response body");
    });

    let serverCase = new HttpTestCase('serve a response');
    serverCase.server().response.tag("first");
    serverCase.serverWillWaitForClients([collapseCase]);
    serverCase.server().serve(resource);

    let collapsePromise = null;
    serverCase.server().response.promiseToReceive().then(() => {
        serverCase.server().response.tag("second");
        serverCase.server().response.promiseToReceive(false);
        collapsePromise = collapseCase.run();
    });

    let serverPromise = serverCase.run();
    let initiatorPromise = initiatorCase.run();
    await initiatorPromise;
    assert(collapsePromise);
    await collapsePromise;
    await serverPromise;

    AddressPool.ReleaseListeningAddress(resource.uri.address);
}

}
