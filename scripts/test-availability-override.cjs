// Run: node scripts/test-availability-override.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const template = fs.readFileSync(path.join(__dirname, '../templates/base.html'), 'utf8');
const source = template.slice(template.indexOf('async function saveWithAvailabilityOverride'), template.indexOf('// Give wide operational tables'));

async function check(replies, approvals, expectedIDs) {
    const requests = [];
    const context = vm.createContext({
        fetch: async (url, options) => {
            requests.push(JSON.parse(options.body));
            assert.ok(replies.length, 'unexpected retry');
            const [status, data] = replies.shift();
            return {status, json: async () => data};
        },
        confirm: () => {
            assert.ok(approvals.length, 'unexpected confirmation');
            return approvals.shift();
        },
    });
    vm.runInContext(source, context);
    await context.saveWithAvailabilityOverride('/api/pos', {items: []});
    assert.deepEqual(requests.map(r => r.acknowledged_stock_ids || []), expectedIDs);
    assert.equal(replies.length, 0);
    assert.equal(approvals.length, 0);
}

(async () => {
    const warning = id => ({success: false, error: 'Fixture warning', unavailable_stock_ids: [id]});
    await check([[400, warning('A')], [400, warning('B')], [200, {success: true}]], [true, true], [[], ['A'], ['A', 'B']]);
    await check([[400, warning('A')]], [false], [[]]);
    await check([[400, {success: false, error: 'Change policy first'}]], [], [[]]);
    await check([[500, warning('A')]], [], [[]]);
    await check([[400, warning('A')], [400, warning('A')]], [true], [[], ['A']]);
    console.log('Availability confirmation checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
