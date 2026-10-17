// Minimal stand-in for the supabase-js query builder, for route tests without
// a database. Each query is recorded and answered by respond(query), which
// returns { data, error }. The real queries are checked against Supabase in
// the live API tests.
//
//   query = { table, op: "select" | "insert" | "upsert" | "update", columns,
//             payload, options, filters: [[method, ...args]], single }

function fakeQuery(table, respond, log) {
  const query = { table, op: "select", columns: undefined, payload: undefined, options: undefined, filters: [], single: false };
  const builder = {
    select(columns) {
      if (query.op === "select") query.columns = columns;
      else query.returning = columns;
      return builder;
    },
    insert(payload) {
      Object.assign(query, { op: "insert", payload });
      return builder;
    },
    upsert(payload, options) {
      Object.assign(query, { op: "upsert", payload, options });
      return builder;
    },
    update(payload) {
      Object.assign(query, { op: "update", payload });
      return builder;
    },
    maybeSingle() {
      query.single = "maybe";
      return builder;
    },
    single() {
      query.single = true;
      return builder;
    },
    then(resolve, reject) {
      log.push(query);
      return Promise.resolve()
        .then(() => respond(query) ?? { data: query.single ? null : [], error: null })
        .then(resolve, reject);
    },
  };
  for (const method of ["eq", "neq", "lt", "lte", "gt", "gte", "in", "is", "order", "limit", "range"]) {
    builder[method] = (...args) => {
      query.filters.push([method, ...args]);
      return builder;
    };
  }
  return builder;
}

// Value of the first filter `method(column, value)` of a query.
function filterValue(query, method, column) {
  return query.filters.find(([m, c]) => m === method && c === column)?.[2];
}

// Replaces supabase.from on the shared client; returns the query log.
function installFakeSupabase(supabase, respond) {
  const log = [];
  supabase.from = (table) => fakeQuery(table, (query) => respond(query), log);
  return log;
}

module.exports = { installFakeSupabase, filterValue };
