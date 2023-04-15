// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests whether an HTTP proxy parses a large stored HTTP response header

import assert from "assert";

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import * as ConfigurationGenerator from "../src/test/ConfigGen";
import * as Range from "../src/http/Range";
import * as RangeParser from "../src/http/one/RangeParser";
import Body from "../src/http/Body";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";
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

    static DataBlocks(cfg) {
        if (cfg.DataBlocks !== undefined) // XXX: Typo-unsafe field access
            return [cfg.dataBlocks()];

        // "Interesting" block numbers:
        // 1: single StoreIOBuffer and local memory page (mem_node) boundary
        // 4: rock cache_dir slot size boundary (16KB)
        // 8: shared memory page size boundary (32KB)
        // 16: default reply_header_max_size boundary (and our test maximum)

        // We always test with 1 and 16 blocks because we want to test with
        // the minimum number of Store activity and with the largest prefix.

        if (cfg.cacheType() === "none")
            return [1, 16];

        if (cfg.cacheType() === "disk") // rock slots
            return [1, 4, 16];

        if (cfg.cacheType() === "mem" && !cfg.smp()) // local memory pages
            return [1, 16];

        if (cfg.cacheType() === "mem" && cfg.smp()) // shared memory pages
            return [1, 8, 16];

        assert(cfg.cacheType() === "all");
        return [1, 4, 8, 16];
    }

    static Deltas(cfg) {
        // XXX: Typo-unsafe field access
        return cfg.DataBlockDelta === undefined ? [-1, 0, 1] : [cfg.dataBlockDelta()];
    }

    static Prefixes(cfg) {
        const prefixes = new Set();
        for (let b of TestConfig.DataBlocks(cfg)) {
            assert(b <= MaxBlock);
            for (let d of TestConfig.Deltas(cfg))
                prefixes.add(TestConfig.ResponsePrefixSize(b, d));
        }
        assert(prefixes.size > 0);
        return Array.from(prefixes);
    }

    static Bodies() {
        return [0, Config.DefaultBodySize(), Config.LargeBodySize()];
    }

    static Ranges() {
        return ['none', 'first', 'middle', 'last', 'beyond', 'fat', 'whole', 'multi'];
    }
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

        if (Config.dutRequestsWhole())
            cfg.custom("range_offset_limit 10 GB");
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
        configGen.dropInvalidConfigurations(MyTest._CheckEarlyConfiguration);
        configGen.dropDuplicateConfigurations(MyTest._SummarizeEarlyConfiguration);

        configGen.dutRequestsWhole(function *(cfg) {
            yield false;
            if (cfg.requestRange() !== "none")
                yield true;
        });

        configGen.cacheType(function *(cfg) {
            yield "none";
            if (cfg.dutRequestsWhole()) {
                yield "disk";
                yield "mem";
                yield "all";
            }
            // else Squid would not cache the 206 (Partial Content) response
        });

        configGen.smp(function *(cfg) {
            yield false;
            if (cfg.cacheType() !== "none")
                yield true;
        });

        // needs cfg.cacheType() and cfg.smp()
        configGen.responsePrefixSizeMinimum(function *(cfg) {
            yield *(TestConfig.Prefixes(cfg));
        });

        return configGen.generateConfigurators();
    }

    static _CheckEarlyConfiguration(cfg) {
        /* void */ MyTest._MakeRangeSpec(cfg.requestRange(), cfg.bodySize());

        // Do allow "probably pointless but working" combinations like testing
        // a cache with uncachable !dutRequestsWhole(). We do not generate
        // them, but the tester may have valid reasons to test them.
    }

    // a (cfg.requestRange(), cfg.bodySize())-based gist, suitable only for
    // early removal of configuration duplicates based on those two settings
    static _SummarizeEarlyConfiguration(cfg) {
        let usefulBodySize = cfg.bodySize();
        const rangeSpecs = MyTest._MakeRangeSpec(cfg.requestRange(), usefulBodySize);
        // If two body sizes are bigger than the last range end, then it is
        // enough to test with just one of those too-large body sizes.
        if (rangeSpecs) {
            const lastSpec = rangeSpecs[rangeSpecs.length-1];
            if (usefulBodySize > lastSpec.high())
                usefulBodySize = lastSpec.high();
        }
        return `${rangeSpecs}/${usefulBodySize}`;
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

            return Range.Specs.from(rangeSpecs.map(raw => new Range.Spec(...raw)));
        }

        // the remaining specs are all single-range specs
        const rangeSpec = MyTest._MakeRawSingleRangeSpec(rangeName, bodySize);
        if (!MyTest._ValidRangeSpec(rangeSpec, bodySize))
            throw new ConfigurationGenerator.ConfigurationError(`'${rangeName}' Range needs more than ${bodySize} body bytes`);
        return Range.Specs.from([new Range.Spec(...rangeSpec)]);
    }

    // TODO: Return a valid Range.Spec or throw.
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

        // were we given an unknown (to this method) single-range rangeName?
        assert(rangeName === "beyond");
        return [ lastPos, lastPos + 1 ];
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

    async testSimpleForwarding() {
        if (Config.cacheType() !== 'none')
            return; // caching is tested by testCaching() and testRangeHandling()

        if (Config.requestRange() !== 'none')
            return; // ranges are tested by testRangeHandling()

        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.body = new Body();
        resource.finalize();

        let missCase = new HttpTestCase(`forward a simple request response with ${Config.responsePrefixSizeMinimum()}-byte header and ${Config.bodySize()}-byte body`);
        missCase.server().serve(resource);
        missCase.client().request.for(resource);
        missCase.addMissCheck();
        await missCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async testRangeHandling() {
        if (Config.requestRange() === 'none')
            return;

        let resource = new Resource();
        resource.makeCachable();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.body = new Body();
        resource.finalize();

        const ranges = this.makeRangeSpecs();
        assert(ranges);

        let missCase = new HttpTestCase(`forward a Range request response with ${Config.responsePrefixSizeMinimum()}-byte header and ${Config.bodySize()}-byte body`);
        missCase.server().serve(resource);
        missCase.client().request.for(resource);
        missCase.client().request.header.add("Range", ranges.toString());

        if (Config.dutRequestsWhole()) {
            // cannot do missCase.addMissCheck() because the proxy does not
            // forward the whole server response to the client in this case

            missCase.server().checks.add((server) => {
                const request = server.transaction().request;
                assert(!request.header.has('Range')); // TODO: codify
            });
        } else {
            missCase.addMissCheck();

            missCase.server().checks.add((server) => {
                const request = server.transaction().request;
                const requestedRanges = Range.Specs.FromRangeHeaderIfPresent(request.header);
                assert(requestedRanges);
                assert(requestedRanges.equal(ranges));
            });
        }

        missCase.client().checks.add((client) => {
            client.expectStatusCode(206);
            const responseParts = RangeParser.ResponseParts(client.transaction().response);
            const expectedParts = Range.Parts.From(ranges, resource.body.whole());
            assert(responseParts.equal(expectedParts));
        });

        await missCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async testCaching() {
        if (Config.cacheType() === "none")
            return;

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
            hitCase.client().request.header.add("Range", ranges.toString());
            hitCase.client().checks.add((client) => {
                client.expectStatusCode(206);
                const responseParts = RangeParser.ResponseParts(client.transaction().response);
                const expectedParts = Range.Parts.From(ranges, resource.body.whole());
                assert(responseParts.equal(expectedParts));
            });
        } else {
            hitCase.addHitCheck(missCase.server().transaction().response);
        }

        await hitCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async run(/*testRun*/) {
        await this.testSimpleForwarding();
        await this.testRangeHandling();
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
        enum: [ 'none', 'mem', 'disk', 'all' ],
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
    {
        option: "dut-requests-whole",
        type: "Boolean",
        default: "false",
        description: "proxy must request the whole response and extract Range parts from it",
    },
]);

