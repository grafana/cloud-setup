import { z } from "zod";

const ipVersion = z.enum(["V4", "V6", "Any"]);

const tlsConfig = z.object({
  caCert: z.string().optional(),
  clientCert: z.string().optional(),
  clientKey: z.string().optional(),
  insecureSkipVerify: z.boolean().optional(),
  serverName: z.string().optional(),
});

const rrValidator = z.object({
  failIfMatchesRegexp: z.array(z.string()).optional(),
  failIfNotMatchesRegexp: z.array(z.string()).optional(),
});

const dnsSettings = z.object({
  ipVersion: ipVersion.optional(),
  server: z.string().optional(),
  port: z.number().optional(),
  recordType: z.enum(["ANY", "A", "AAAA", "CNAME", "MX", "NS", "PTR", "SOA", "SRV", "TXT"]).optional(),
  protocol: z.enum(["TCP", "UDP"]).optional(),
  sourceIpAddress: z.string().optional(),
  validRCodes: z.array(z.string()).optional(),
  validateAnswerRrs: rrValidator.optional(),
  validateAuthorityRrs: rrValidator.optional(),
  validateAdditionalRrs: rrValidator.optional(),
});

const headerMatch = z.object({
  header: z.string(),
  regexp: z.string(),
  allowMissing: z.boolean().optional(),
});

const httpSettings = z.object({
  ipVersion: ipVersion.optional(),
  method: z.enum(["GET", "CONNECT", "DELETE", "HEAD", "OPTIONS", "POST", "PUT", "TRACE"]).optional(),
  headers: z.array(z.string()).optional(),
  body: z.string().optional(),
  noFollowRedirects: z.boolean().optional(),
  tlsConfig: tlsConfig.optional(),
  basicAuth: z.object({ username: z.string(), password: z.string() }).optional(),
  bearerToken: z.string().optional(),
  proxyUrl: z.string().optional(),
  failIfSsl: z.boolean().optional(),
  failIfNotSsl: z.boolean().optional(),
  compression: z.enum(["none", "identity", "br", "gzip", "deflate"]).optional(),
  validStatusCodes: z.array(z.number()).optional(),
  validHttpVersions: z.array(z.string()).optional(),
  failIfBodyMatchesRegexp: z.array(z.string()).optional(),
  failIfBodyNotMatchesRegexp: z.array(z.string()).optional(),
  failIfHeaderMatchesRegexp: z.array(headerMatch).optional(),
  failIfHeaderNotMatchesRegexp: z.array(headerMatch).optional(),
  cacheBustingQueryParamName: z.string().optional(),
});

const pingSettings = z.object({
  ipVersion: ipVersion.optional(),
  sourceIpAddress: z.string().optional(),
  payloadSize: z.number().optional(),
  dontFragment: z.boolean().optional(),
});

const tcpQueryResponse = z.object({
  send: z.string(),
  expect: z.string(),
  startTls: z.boolean().optional(),
});

const tcpSettings = z.object({
  ipVersion: ipVersion.optional(),
  sourceIpAddress: z.string().optional(),
  tls: z.boolean().optional(),
  tlsConfig: tlsConfig.optional(),
  queryResponse: z.array(tcpQueryResponse).optional(),
});

const tracerouteSettings = z.object({
  maxHops: z.number().optional(),
  maxUnknownHops: z.number().optional(),
  ptrLookup: z.boolean().optional(),
});

const grpcSettings = z.object({
  ipVersion: ipVersion.optional(),
  service: z.string().optional(),
  tls: z.boolean().optional(),
  tlsConfig: tlsConfig.optional(),
});

const scriptedSettings = z.object({
  script: z.string(),
});

const browserSettings = z.object({
  script: z.string(),
});

const multiHttpVariable = z.object({
  type: z.enum(["JSON_PATH", "REGEX", "CSS_SELECTOR"]),
  name: z.string().optional(),
  expression: z.string().optional(),
  attribute: z.string().optional(),
});

const multiHttpAssertion = z.object({
  type: z.enum(["TEXT", "JSON_PATH_VALUE", "JSON_PATH_ASSERTION", "REGEX_ASSERTION"]),
  subject: z.enum(["RESPONSE_HEADERS", "HTTP_STATUS_CODE", "RESPONSE_BODY"]).optional(),
  condition: z.enum(["NOT_CONTAINS", "EQUALS", "STARTS_WITH", "ENDS_WITH", "TYPE_OF", "CONTAINS"]).optional(),
  expression: z.string().optional(),
  value: z.string().optional(),
});

const multiHttpEntry = z.object({
  request: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]),
    url: z.string(),
    body: z
      .object({
        contentType: z.string().optional(),
        contentEncoding: z.string().optional(),
        payload: z.string().optional(),
      })
      .optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    queryFields: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  }),
  variables: z.array(multiHttpVariable).optional(),
  checks: z.array(multiHttpAssertion).optional(),
});

const multiHttpSettings = z.object({
  entries: z.array(multiHttpEntry),
});

const settingsShape = {
  http: httpSettings.optional(),
  dns: dnsSettings.optional(),
  ping: pingSettings.optional(),
  tcp: tcpSettings.optional(),
  traceroute: tracerouteSettings.optional(),
  grpc: grpcSettings.optional(),
  scripted: scriptedSettings.optional(),
  browser: browserSettings.optional(),
  multihttp: multiHttpSettings.optional(),
};

const settingsKeys = Object.keys(settingsShape) as (keyof typeof settingsShape)[];

export const settingsSchema = z
  .object(settingsShape)
  .refine((s) => settingsKeys.filter((k) => s[k] !== undefined).length === 1, {
    message: `Exactly one check type must be specified in settings (${settingsKeys.join(", ")})`,
  });

export const checkDefinitionSchema = z.object({
  target: z.string(),
  probes: z.array(z.string()).min(1),
  frequency: z.number().optional(),
  timeout: z.number().optional(),
  enabled: z.boolean().optional(),
  alertSensitivity: z.enum(["none", "low", "medium", "high"]).optional(),
  basicMetricsOnly: z.boolean().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  settings: settingsSchema,
});

export const syntheticConfigSchema = z.record(z.string(), checkDefinitionSchema);

export type CheckSettings = z.infer<typeof settingsSchema>;
export type CheckDefinition = z.infer<typeof checkDefinitionSchema>;
export type SyntheticConfig = z.infer<typeof syntheticConfigSchema>;

export function defineConfig(config: SyntheticConfig): SyntheticConfig {
  return config;
}
