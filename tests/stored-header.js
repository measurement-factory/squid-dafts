// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests whether an HTTP proxy parses a large stored HTTP response header

import assert from "assert";
import HttpTestCase from "../src/test/HttpCase";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import * as Config from "../src/misc/Config";
import * as AddressPool from "../src/misc/AddressPool";
import Test from "../src/overlord/Test";
import * as ConfigurationGenerator from "../src/test/ConfigGen";
import { RandomText } from "../src/misc/Gadgets";

/*
Squid reads a disk-stored entry by fixed-size data blocks.

Each entry starts with swap meta headers, followed by a stored HTTP message.
We need to know the swap meta headers size so that we could generate HTTP
header of the required length (e.g., occupying the rest of the first data block).

Though the swap meta header size depends on the response, we can calculate it for
known responses used in this test.

Swap meta headers in Squid are represented by the SwapMeta structure:

struct SwapMeta {
    struct Prefix {
        char magic;
        int swap_hdr_sz;
    };
    Prefix prefix;
    struct TLV {
        char type;
        int length;
        char value[length];
    };
    TLV fields[];
};

Responses generated in this test produce TLVs of 4 types.
We can calculate TLV::length for each of them:

STORE_META_KEY
    fixed 16-byte length
STORE_META_STD_LFS calculated as
    (4*sizeof(time_t)+2*sizeof(uint16_t)+sizeof(uint64_t) = 4*8 + 2*2 + 8 = 44
STORE_META_URL can be calculated for fixed-length URLs
    url.length() + 1 = 37 + 1 = 38 (37 is the length of the test-produced URLs like http://localhost:8080/path-94nsv9omj3)
STORE_META_OBJSIZE
    sizeof(int64_t) = 8

The length of the entire meta header is
sizeof(Prefix)+sizeof(fields) = 1+sizeof(int)+4*(1+sizeof(int))+16+44+38+8 = 5+20+16+44+38+8=131
*/
const SwapMetaHeaderSize = 131;

// Expected reply_header_max_size (default) setting minus 1. We subtract one
// because Squid interprets the setting as the prohibited "too large" size
// rather than the allowed maximum size.
const ResponsePrefixSizeMaximum = 64*1024 - 1;

// Squid constant
const DataBlockSize = 4096;

// XXX: Explain why we assume zero body size here (or stop assuming?).
// XXX: Account for Rock db cell metadata
const StoredEntrySizeMax = ResponsePrefixSizeMaximum + SwapMetaHeaderSize;
const MaxBlock = Math.ceil(StoredEntrySizeMax / DataBlockSize);

class TestConfig
{
    static ResponsePrefixSize(blocks, delta) {
        const firstBlock = DataBlockSize - SwapMetaHeaderSize;
        const fullBlocks = blocks === MaxBlock ? blocks - 2 : blocks -1;
        const lastBlock = blocks === MaxBlock ? SwapMetaHeaderSize : 0;
        const total = firstBlock + DataBlockSize * fullBlocks + lastBlock + delta;
        // Do not produce responses that are going to be rejected before storage.
        return Math.min(total, ResponsePrefixSizeMaximum);
    }

    static DataBlocks() {
        if (Config.DataBlocks === undefined) { // XXX: Config access before configuration is generated?
            return [
                1, // single disk page boundary
                // TODO: Drop 2 because 8 will test no-metadata case?
                2, // two disk pages, the second one without swap metadata
                8, // shared memory page size boundary
                // TODO: Probably only 16 below is needed because +1 delta
                // will test 17 as well. However, there may be other reasons
                // to cross that 64KB threshold (with an increased
                // reply_header_max_size). XXX: We stopped triggering 431
                // responses so anything beyond 16 will be skipped?
                16, // default reply_header_max_size boundary
                17, // exceeds default reply_header_max_size
            ];
        }

        assert(Config.dataBlocks() > 0);
        return [Config.dataBlocks()];
    }

    static Deltas() {
        // XXX: Config access before configuration is generated
        return Config.DataBlockDelta === undefined ? [-1, 0, 1] : [Config.dataBlockDelta()];
    }

    static Prefixes() {
        let prefixes = [];
        for (let b of TestConfig.DataBlocks()) {
            assert(b <= MaxBlock);
            for (let d of TestConfig.Deltas())
                prefixes.push(TestConfig.ResponsePrefixSize(b, d));
        }
        assert(prefixes.length > 0);
        return prefixes;
    }

    static Bodies() {
        return [0, Config.DefaultBodySize(), Config.LargeBodySize()];
    }

    static Ranges() {
        return ['none', 'first', 'middle', 'last', 'beyond', 'fat', 'whole', 'multi'];
    }

    static cacheType() { return [ 'mem', 'disk', 'all' ]; }

    static smpMode() { return [ false, true ]; }
}

export default class MyTest extends Test {

    _configureDut(cfg) {
        const memCache = Config.cacheType() === 'mem' || Config.cacheType() === 'all';
        const diskCache = Config.cacheType() === 'disk' || Config.cacheType() === 'all';
        cfg.memoryCaching(memCache);
        cfg.diskCaching(diskCache);
        if (Config.smp()) {
            cfg.workers(2);
            cfg.dedicatedWorkerPorts(true);
            this._workerListeningAddresses = cfg.workerListeningAddresses();
        }
    }

    static Configurators() {
        const configGen = new ConfigurationGenerator.FlexibleConfigGen();

        configGen.bodySize(TestConfig.Bodies());

        // Do not attempt to filter our incompatible (rangeName, bodySize)
        // pairs inside the generator function because the function is not
        // called when the configuration parameter is explicitly configured.
        // Explicitly configured values may also lead to incompatible pairs.
        configGen.requestRange(TestConfig.Ranges());

        // check ASAP, to minimize the number of configurations to scan/drop
        // and reduce configuration summation overheads
        configGen.dropInvalidConfigurations(MyTest._CheckConfiguration);
        configGen.dropDuplicateConfigurations(MyTest._SummarizeEarlyConfiguration);

        configGen.responsePrefixSizeMinimum(TestConfig.Prefixes());

        configGen.cacheType(TestConfig.cacheType());

        configGen.smp(TestConfig.smpMode());

        return configGen.generateConfigurators();
    }

    static _CheckConfiguration(cfg) {
        /* void */ MyTest._MakeRangeSpec(cfg.requestRange(), cfg.bodySize());
    }

    // a (cfg.requestRange(), cfg.bodySize())-based gist, suitable only for
    // early removal of configuration duplicates based on those two settings
    static _SummarizeEarlyConfiguration(cfg) {
        const rangeSpecs = MyTest._MakeRangeSpec(cfg.requestRange(), cfg.bodySize());
        return `${rangeSpecs}/${cfg.bodySize()}`;
    }

    static _MakeRangeSpec(rangeName, bodySize) {
        if (rangeName === "none")
            return null;

        if (rangeName === "multi") {
            // a few single-range specs, in increasing order of the first offset
            const rangeSpecsRaw = [
                MyTest._MakeRawSingleRangeSpec("first", bodySize),
                MyTest._MakeRawSingleRangeSpec("middle", bodySize),
                MyTest._MakeRawSingleRangeSpec("last", bodySize),
            ];

            // filter out individual failed entries
            const rangeSpecs = rangeSpecsRaw.filter(
                rangeSpec => MyTest._ValidRangeSpec(rangeSpec, bodySize));

            // we do not filter out _overlapping_ range specs (yet?)

            // the purpose of 'multi' is to test handling of _multiple_ specs
            if (rangeSpecs.length <= 1)
                throw new ConfigurationGenerator.ConfigurationError(`'multi' Range needs more than ${bodySize} body bytes`);
            return rangeSpecs;
        }

        // the remaining specs are all single-range specs
        const rangeSpec = MyTest._MakeRawSingleRangeSpec(rangeName, bodySize);
        if (!MyTest._ValidRangeSpec(rangeSpec, bodySize))
            throw new ConfigurationGenerator.ConfigurationError(`'${rangeName}' Range needs more than ${bodySize} body bytes`);
        return [ rangeSpec ];
    }

    // A single [low, high] range specification.
    // May return invalid offsets; the caller must check!
    static _MakeRawSingleRangeSpec(rangeName, bodySize) {
        // HTTP byte ranges are inclusive and their offsets start at zero
        const lastPos = bodySize - 1;

        if (rangeName === "first") {
            return [ 0, 0 ];
        }

        if (rangeName === "middle") {
            const middleByteOffset = Math.floor(Config.bodySize()/2);
            return [ middleByteOffset, middleByteOffset ];
        }

        if (rangeName === "last") {
            return [ lastPos, lastPos];
        }

        if (rangeName === "fat") {
            return [ 1, lastPos - 1];
        }

        if (rangeName === "whole") {
            return [ 0, lastPos];
        }

        if (rangeName === "beyond") {
            return [ lastPos, lastPos + 1 ];
        }

        assert(false); // unknown (to this method) single-range rangeName
    }

    static _ValidRangeSpec(rangeSpec, bodySize) {
        assert.strictEqual(rangeSpec.length, 2);
        if (rangeSpec[0] < 0 || rangeSpec[1] < 0)
            return false; // no negative offsets
        if (rangeSpec[0] > rangeSpec[1])
            return false; // no first-pos > last-pos ranges
        if (rangeSpec[0] >= bodySize)
            return false; // no unsatisfiable ranges
        return true;
    }

    // (an array of range pairs or null) matching current configuration
    makeRangeSpecs() {
        return MyTest._MakeRangeSpec(Config.requestRange(), Config.bodySize());
    }

    // whether the two arrays are equal
    arraysAreEqual(a1, a2) {
        const isA1 = Array.isArray(a1);
        const isA2 = Array.isArray(a2);

        if ((!isA1 && isA2) || (isA1 && !isA2))
            return false;
        if (!isA1)
            return a1 === a2;
        if (a1.length !== a2.length)
            return false;
        for (let i=0; i < a1.length; ++i) {
            if (!this.arraysAreEqual(a1[i], a2[i]))
                return false;
        }
        return true;
    }

    async testRangeResponse() {
        const ranges = this.makeRangeSpecs();
        if (!ranges)
            return;

        let resource = new Resource();
        resource.makeCachable();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.body = new Body(RandomText("body-", Config.bodySize()), ranges);
        resource.finalize();

        let missCase = new HttpTestCase(`forward a response to a range request with ${Config.responsePrefixSizeMinimum()}-byte header and ${Config.bodySize()}-byte body`);
        missCase.server().serve(resource);
        missCase.client().request.for(resource);
        missCase.client().request.addRanges(ranges);

        missCase.addMissCheck();

        missCase.client().checks.add((client) => {
            client.expectStatusCode(206);
            const response = client.transaction().response;
            // XXX: We cannot easily compare ranges because requested high in
            // a "beyond" range may be higher than the high in the response:
            // this.arraysAreEqual(ranges, response.ranges).
            // TODO: Test that the expected _content_ was received.
            assert.strictEqual(ranges.length, response.ranges.length);
        });

        missCase.server().checks.add((server) => {
            const request = server.transaction().request;
            assert(this.arraysAreEqual(ranges, request.parseRangeHeader()));
        });

        await missCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async testCaching() {
        let resource = new Resource();
        resource.makeCachable();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.body = new Body();
        resource.finalize();

        let missCase = new HttpTestCase(`forward a response with ${Config.responsePrefixSizeMinimum()}-byte header and ${Config.bodySize()}-byte body`);
        missCase.server().serve(resource);
        missCase.client().request.for(resource);
        if (Config.smp())
            missCase.client().nextHopAddress = this._workerListeningAddresses[1];
        missCase.addMissCheck();

        await missCase.run();

        await this.dut.finishCaching();

        const ranges = this.makeRangeSpecs();
        const hitHow = ranges ? ` with a '${Config.requestRange()}' range request` : '';
        const hitCase = new HttpTestCase(`hit a ${Config.responsePrefixSizeMinimum()}-byte header and ${Config.bodySize()}-byte body response${hitHow}`);
        hitCase.client().request.for(resource);
        if (Config.smp())
            hitCase.client().nextHopAddress = this._workerListeningAddresses[2];
        if (ranges) {
            hitCase.client().request.addRanges(ranges);
            hitCase.client().checks.add((client) => {
                client.expectStatusCode(206);
                const response = client.transaction().response;
                // XXX: See another XXX about this commented out check.
                // XXXX: Code duplication
                // assert(this.arraysAreEqual(ranges, response.ranges));
                assert.strictEqual(ranges.length, response.ranges.length);
            });
        } else {
            hitCase.addHitCheck(missCase.server().transaction().response);
        }

        await hitCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async run(/*testRun*/) {
        await this.testRangeResponse();
        await this.testCaching();
    }
}

Config.Recognize([
    {
        option: "data-blocks",
        type: "Number",
        description: `The number of Squid swap data blocks (${DataBlockSize} bytes each) that will be occupied by the response header`,
    },
    {
        option: "data-block-delta",
        type: "Number",
        description: "Allows to generate a header that will be less, equal to, or greater than the data blocks size",
    },
    {
        // XXX: Replace with dut-cache-...
        option: "cache-type",
        type: "String",
        enum: ["mem", "disk", "all"],
        description: "Turns on rock disk cache",
    },
    {
        option: "smp",
        type: "Boolean",
        default: "false",
        description: "In this mode MISS and HIT requests will go to different proxy SMP workers",
    },
    {
        option: "request-range",
        type: "String",
        enum: TestConfig.Ranges(),
        default: "none",
        description: "HTTP Range request header to send to the proxy",
    },
]);

