// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Creates a rock cache_dir entry without an inode that triggers "store entry
// metadata prefix is corrupted" UnpackPrefix() ERRORs after buggy rock
// cache_dir index rebuilding code adds that truncated entry into the index.

import { FlexibleConfigGen } from "../src/test/ConfigGen.js";
import * as AddressPool from "../src/misc/AddressPool.js";
import * as Gadgets from "../src/misc/Gadgets.js";
import assert from "assert";
import Body from "../src/http/Body.js";
import Config from "../src/misc/Config.js";
import HttpTestCase from "../src/test/HttpCase.js";
import Resource from "../src/anyp/Resource.js";
import Test from "../src/overlord/Test.js";

export default class MyTest extends Test {

    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.dutDiskCache(function *(cfg) {
            yield true;
        });

        return configGen.generateConfigurators();
    }

    constructor() {
        super(...arguments);
        this._serverAddress = null; // origin server address
    }

    async run(/*testRun*/) {
        this._serverAddress = AddressPool.ReserveListeningAddress();

        const caseLong = await this._cacheOne("Long", 3); // disk slots: a2, a1, a3, empty, ...
        await this._purgeOne(caseLong);
        const caseShort = await this._cacheOne("Short", 2); // disk slots: b1, b2, a3, empty, ...
        await this.dut.restart(); // loads B; unpatched code also loads inode-lacking a3

        // Accessing the long entry after restart() triggers ERRORs in
        // unpatched code when Squid tries to load Store entry metadata from slot a3:
        // ERROR: Failed to unpack Store entry metadata: store entry metadata prefix is corrupted
        await this._checkNotCached(caseLong);

        await this._checkStillCached(caseShort);

        AddressPool.ReleaseListeningAddress(this._serverAddress);
    }

    async _cacheOne(resourceLabel, slotCount) {
        assert(slotCount > 0);

        const resource = new Resource();
        resource.uri.address = this._serverAddress;
        resource.uri.makeUnique(`/label=${resourceLabel},slotCount=${slotCount}/`);
        resource.makeCachable();
        const slotSize = 16*1024; // TODO: Make configurable, propagate to the cache_dir directive generator

        // Rock metadata, store metadata, and HTTP response header consume
        // slot bytes. We are not trying to estimate precisely. We are just
        // trying to satisfy the two assertions below.
        const metadataSize = slotSize / 3;
        const bodySize = slotCount*slotSize - metadataSize;
        assert(metadataSize > 600); // all that metadata is likely to fit
        assert(bodySize > (slotCount-1)*slotSize); // we will consume at least slotCount slots

        resource.body = new Body(Gadgets.RandomText("body-", bodySize));
        resource.finalize();

        const missCase = new HttpTestCase(`cache ${resource.uri.path}`);
        missCase.server().serve(resource);
        missCase.client().request.for(resource);
        missCase.addMissCheck();
        await missCase.run();

        await this.dut.finishCaching();

        await this._checkStillCached(missCase);
        return missCase;
    }

    _checkStillCached(cachingCase) {
        const uri = cachingCase.client().transaction().request.startLine.uri;
        let hitCase = new HttpTestCase(`hit cached ${uri.path}`);
        hitCase.client().request.target(uri);
        hitCase.addHitCheck(cachingCase.server().transaction().response);
        return hitCase.run();
    }

    // XXX: Duplicates _checkPurging() in purge-cached.js
    _checkNotCached(cachingCase) {
        const uri = cachingCase.client().transaction().request.startLine.uri;
        let myCase = new HttpTestCase(`check not cached ${uri.path}`);
        myCase.client().request.target(uri);
        myCase.client().request.header.add("Cache-Control", "only-if-cached");
        myCase.client().checks.add(client => client.expectStatusCode(504));
        return myCase.run();
    }

    _purgeOne(cachingCase) {
        const uri = cachingCase.client().transaction().request.startLine.uri;
        let purgeCase = new HttpTestCase(`purge cached ${uri.path}`);
        purgeCase.server().listenAt(uri.address);
        purgeCase.client().request.target(uri);
        purgeCase.client().request.startLine.method = 'DELETE';
        purgeCase.addMissCheck();
        return purgeCase.run();
    }

}
