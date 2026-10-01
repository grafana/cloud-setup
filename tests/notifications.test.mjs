import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AlertingApiError,
  AlertingClient,
  SM_CONTACT_POINT_NAME,
} from "../dist/products/syntheticMonitoring/notifications.js";

const PROXY = "https://stack.example/api/cli/v1/proxy";
const API_VERSION = "notifications.alerting.grafana.app/v1beta1";
const NAMESPACE = "stacks-123";
const BASE = `/apis/${API_VERSION}/namespaces/${NAMESPACE}`;
const RECEIVERS = `${BASE}/receivers`;
const TREE = `${BASE}/routingtrees/user-defined`;

function email(addresses = "before@example.com") {
  return {
    uid: "existing-email-integration",
    type: "email",
    version: "v1",
    settings: { addresses, subject: "Custom subject", singleEmail: true },
    disableResolveMessage: true,
  };
}

function receiver(integrations = [email()]) {
  return {
    apiVersion: API_VERSION,
    kind: "Receiver",
    metadata: {
      // The API resource name differs from both the title and integration UID.
      name: "receiver-resource-id",
      namespace: NAMESPACE,
      resourceVersion: "receiver-version-1",
      annotations: { "grafana.com/provenance": "", "grafana.com/access/canWrite": "true" },
    },
    spec: { title: SM_CONTACT_POINT_NAME, integrations },
  };
}

function tree(routes = []) {
  return {
    apiVersion: API_VERSION,
    kind: "RoutingTree",
    metadata: {
      name: "user-defined",
      namespace: NAMESPACE,
      resourceVersion: "tree-version-1",
      annotations: { "grafana.com/provenance": "" },
    },
    spec: {
      defaults: { receiver: "existing-default", group_by: ["team"], repeat_interval: "8h" },
      routes,
    },
  };
}

function smRoute(type = "=") {
  return {
    receiver: SM_CONTACT_POINT_NAME,
    matchers: [{ label: "namespace", type, value: "synthetic_monitoring" }],
    group_by: ["grafana_folder", "alertname", "instance", "job"],
    continue: false,
  };
}

function setup(t, handler) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(url.startsWith(PROXY));
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(options.headers["X-Client-Id"], "grafana-synthetics-cli");
    assert.equal(options.headers["X-Disable-Provenance"], undefined);
    const call = {
      path: url.slice(PROXY.length),
      method: options.method,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    calls.push(call);
    if (call.body !== undefined) assert.equal(options.headers["Content-Type"], "application/json");
    const response = await handler(call);
    if (response) return response;
    if (call.path === "/api/frontend/settings") return Response.json({ namespace: NAMESPACE });
    if (call.path === "/api/user") return Response.json({ email: "signedin@example.com" });
    assert.fail(`Unexpected ${call.method} ${call.path}`);
  });
  return { client: new AlertingClient(PROXY, "test-token"), calls };
}

test("inspection finds the existing email integration and resolves Grafana's namespace only once", async (t) => {
  const existing = receiver([
    { uid: "slack-id", type: "slack", version: "v1", settings: {} },
    email("  existing@example.com  "),
  ]);
  const { client, calls } = setup(t, ({ path }) => {
    if (path === RECEIVERS) return Response.json({ items: [existing] });
  });
  assert.deepEqual(await client.inspect(), {
    existingAddresses: "existing@example.com",
    userEmail: "signedin@example.com",
  });
  assert.equal(await client.ensureContactPoint("existing@example.com"), "unchanged");
  assert.equal(calls.filter(({ path }) => path === "/api/frontend/settings").length, 1);
  assert.ok(calls.every(({ method }) => method === "GET"));
});

test("a missing profile email does not prevent reading the contact point", async (t) => {
  const { client } = setup(t, ({ path }) => {
    if (path === "/api/user") return Response.json({ message: "Forbidden" }, { status: 403 });
    if (path === RECEIVERS) return Response.json({ items: [receiver()] });
  });
  assert.deepEqual(await client.inspect(), { existingAddresses: "before@example.com", userEmail: undefined });
});

test("creating an editable receiver leaves its resource name and integration UID to Grafana", async (t) => {
  const { client, calls } = setup(t, ({ path, method }) => {
    if (path !== RECEIVERS) return;
    return method === "GET" ? Response.json({ items: [] }) : Response.json(receiver(), { status: 201 });
  });
  assert.equal(await client.ensureContactPoint("ops@example.com;backup@example.com"), "created");
  assert.deepEqual(calls.find(({ method }) => method === "POST").body, {
    apiVersion: API_VERSION,
    kind: "Receiver",
    metadata: { namespace: NAMESPACE },
    spec: {
      title: SM_CONTACT_POINT_NAME,
      integrations: [
        {
          type: "email",
          version: "v1",
          settings: { addresses: "ops@example.com;backup@example.com" },
          disableResolveMessage: false,
        },
      ],
    },
  });
});

test("updating email preserves other integrations, secret references, settings and resource metadata", async (t) => {
  const slack = {
    uid: "slack-id",
    type: "slack",
    version: "v1",
    settings: { recipient: "#oncall" },
    secureFields: { token: true },
  };
  const existing = receiver([slack, email(), { ...email("other@example.com"), uid: "second-email" }]);
  existing.metadata.annotations["grafana.com/provenance"] = "api";
  existing.metadata.annotations["example.com/owner"] = "team";
  const { client, calls } = setup(t, ({ path, method }) => {
    if (path === RECEIVERS) return Response.json({ items: [existing] });
    if (path === `${RECEIVERS}/${existing.metadata.name}` && method === "PUT") return Response.json({});
  });
  assert.equal(await client.ensureContactPoint("after@example.com"), "updated");
  const expected = structuredClone(existing);
  expected.spec.integrations[1].settings.addresses = "after@example.com";
  assert.deepEqual(calls.find(({ method }) => method === "PUT").body, expected);
});

test("a receiver without email gets an email integration without replacing its other integrations", async (t) => {
  const slack = { uid: "slack-id", type: "slack", version: "v1", settings: {}, secureFields: { url: true } };
  const existing = receiver([slack]);
  const { client, calls } = setup(t, ({ path, method }) => {
    if (path === RECEIVERS) return Response.json({ items: [existing] });
    if (method === "PUT") return Response.json({});
  });
  assert.equal(await client.ensureContactPoint("ops@example.com"), "updated");
  const updated = calls.find(({ method }) => method === "PUT").body;
  assert.deepEqual(updated.spec.integrations[0], slack);
  assert.equal(updated.spec.integrations[1].type, "email");
  assert.equal(updated.spec.integrations[1].settings.addresses, "ops@example.com");
});

test("receiver lookup follows pagination before deciding whether to create a contact point", async (t) => {
  const other = receiver();
  other.spec.title = "other-team";
  const { client, calls } = setup(t, ({ path }) => {
    if (path === RECEIVERS) return Response.json({ metadata: { continue: "next+/=" }, items: [other] });
    if (path === `${RECEIVERS}?continue=next%2B%2F%3D`) return Response.json({ items: [receiver()] });
  });
  assert.equal(await client.ensureContactPoint("before@example.com"), "unchanged");
  assert.ok(calls.every(({ method }) => method === "GET"));
});

test("a receiver conflict rereads and preserves concurrent changes before retrying", async (t) => {
  let current = receiver();
  let writes = 0;
  const { client, calls } = setup(t, ({ path, method }) => {
    if (path === RECEIVERS) return Response.json({ items: [current] });
    if (method === "PUT") {
      if (++writes === 1) {
        current = receiver([email(), { type: "webhook", version: "v1", settings: {}, uid: "concurrent" }]);
        current.metadata.resourceVersion = "receiver-version-2";
        current.spec.integrations[0].settings.subject = "Concurrently edited";
        return Response.json({ message: "Conflict" }, { status: 409 });
      }
      return Response.json({});
    }
  });
  assert.equal(await client.ensureContactPoint("after@example.com"), "updated");
  const puts = calls.filter(({ method }) => method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].body.metadata.resourceVersion, "receiver-version-1");
  const expected = structuredClone(current);
  expected.spec.integrations[0].settings.addresses = "after@example.com";
  assert.deepEqual(puts[1].body, expected);
});

test("a concurrent receiver creation is reused instead of creating another contact point", async (t) => {
  let created = false;
  const { client, calls } = setup(t, ({ path, method }) => {
    if (path !== RECEIVERS) return;
    if (method === "GET") return Response.json({ items: created ? [receiver([email("ops@example.com")])] : [] });
    created = true;
    return Response.json({ message: "Already exists" }, { status: 409 });
  });
  assert.equal(await client.ensureContactPoint("ops@example.com"), "unchanged");
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
  assert.equal(calls.filter(({ method }) => method === "PUT").length, 0);
});

test("routing appends the SM policy to the default tree without changing defaults or existing routes", async (t) => {
  const existing = tree([
    {
      receiver: "other-team",
      matchers: [{ label: "team", type: "=", value: "ops" }],
      continue: true,
      mute_time_intervals: ["weekend"],
      routes: [{ receiver: "pager", continue: false, group_wait: "1m" }],
    },
  ]);
  existing.spec.additionalSetting = { keep: true };
  const { client, calls } = setup(t, ({ path, method }) => {
    if (path === TREE) return Response.json(method === "GET" ? existing : {});
  });
  assert.equal(await client.ensureRoute(), "created");
  assert.deepEqual(
    calls.find(({ method }) => method === "PUT"),
    {
      path: TREE,
      method: "PUT",
      body: { ...existing, spec: { ...existing.spec, routes: [...existing.spec.routes, smRoute()] } },
    },
  );
});

for (const type of ["=", "=~"])
  test(`an existing SM route with ${type} matching is left unchanged`, async (t) => {
    const existingRoute = { ...smRoute(type), group_by: ["team"], repeat_interval: "12h" };
    const { client, calls } = setup(t, ({ path }) => {
      if (path === TREE) return Response.json(tree([existingRoute]));
    });
    assert.equal(await client.ensureRoute(), "unchanged");
    assert.ok(calls.every(({ method }) => method === "GET"));
  });

test("a route with the wrong receiver or namespace does not suppress the SM policy", async (t) => {
  const existing = tree([
    { ...smRoute(), receiver: "other-team" },
    { ...smRoute(), matchers: [{ label: "namespace", type: "=", value: "other" }] },
  ]);
  const { client, calls } = setup(t, ({ path, method }) => {
    if (path === TREE) return Response.json(method === "GET" ? existing : {});
  });
  assert.equal(await client.ensureRoute(), "created");
  assert.deepEqual(calls.find(({ method }) => method === "PUT").body.spec.routes, [...existing.spec.routes, smRoute()]);
});

test("a routing conflict remerges into the latest policy tree", async (t) => {
  let current = tree();
  let writes = 0;
  const { client, calls } = setup(t, ({ path, method }) => {
    if (path !== TREE) return;
    if (method === "GET") return Response.json(current);
    if (++writes === 1) {
      current = tree([{ receiver: "concurrent-policy", continue: false }]);
      current.spec.defaults.receiver = "new-default";
      current.metadata.resourceVersion = "tree-version-2";
      return Response.json({ message: "Conflict" }, { status: 409 });
    }
    return Response.json({});
  });
  assert.equal(await client.ensureRoute(), "created");
  const puts = calls.filter(({ method }) => method === "PUT");
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[1].body, {
    ...current,
    spec: { ...current.spec, routes: [...current.spec.routes, smRoute()] },
  });
});

test("a retry does not duplicate an SM route added concurrently", async (t) => {
  let written = false;
  const { client, calls } = setup(t, ({ path, method }) => {
    if (path !== TREE) return;
    if (method === "GET") return Response.json(tree(written ? [smRoute()] : []));
    written = true;
    return Response.json({ message: "Conflict" }, { status: 409 });
  });
  assert.equal(await client.ensureRoute(), "unchanged");
  assert.equal(calls.filter(({ method }) => method === "PUT").length, 1);
});

for (const operation of ["ensureContactPoint", "ensureRoute"]) {
  for (const status of [403, 409, 500])
    test(`${operation} bounds conflict retries and preserves HTTP ${status} errors`, async (t) => {
      const { client, calls } = setup(t, ({ path, method }) => {
        if (method === "PUT") return Response.json({ message: "Write failed" }, { status });
        if (path === RECEIVERS) return Response.json({ items: [receiver()] });
        if (path === TREE) return Response.json(tree());
      });
      await assert.rejects(client[operation]("after@example.com"), (error) => {
        assert.ok(error instanceof AlertingApiError);
        assert.equal(error.status, status);
        assert.deepEqual(JSON.parse(error.body), { message: "Write failed" });
        return true;
      });
      const expectedAttempts = status === 409 ? 3 : 1;
      assert.equal(calls.filter(({ method }) => method === "PUT").length, expectedAttempts);
      assert.equal(
        calls.filter(
          ({ path, method }) => method === "GET" && path === (operation === "ensureRoute" ? TREE : RECEIVERS),
        ).length,
        expectedAttempts,
      );
    });

  for (const missingField of ["name", "resourceVersion"])
    test(`${operation} refuses to write a resource missing ${missingField}`, async (t) => {
      const existingReceiver = receiver();
      const existingTree = tree();
      delete existingReceiver.metadata[missingField];
      delete existingTree.metadata[missingField];
      const { client, calls } = setup(t, ({ path }) => {
        if (path === RECEIVERS) return Response.json({ items: [existingReceiver] });
        if (path === TREE) return Response.json(existingTree);
      });
      await assert.rejects(client[operation]("after@example.com"), /missing a name or resource version/);
      assert.ok(calls.every(({ method }) => method === "GET"));
    });
}

for (const namespace of [undefined, "", "  ", 123])
  test(`a missing or invalid namespace (${JSON.stringify(namespace)}) never falls back to a guessed namespace`, async (t) => {
    const { client, calls } = setup(t, ({ path }) => {
      if (path === "/api/frontend/settings") return Response.json({ namespace });
    });
    await assert.rejects(client.ensureContactPoint("ops@example.com"), /did not return an API namespace/);
    assert.deepEqual(
      calls.map(({ path }) => path),
      ["/api/frontend/settings"],
    );
  });

test("a namespace lookup permission failure is surfaced before any receiver request", async (t) => {
  const { client, calls } = setup(t, ({ path }) => {
    if (path === "/api/frontend/settings") return Response.json({ message: "Forbidden" }, { status: 403 });
  });
  await assert.rejects(
    client.ensureContactPoint("ops@example.com"),
    (error) => error instanceof AlertingApiError && error.status === 403,
  );
  assert.equal(calls.length, 1);
});
