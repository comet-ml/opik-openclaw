export function definePluginEntry(definition) {
  return definition;
}

export function emptyPluginConfigSchema() {
  return {
    jsonSchema: { type: "object", additionalProperties: false, properties: {} },
    parse: (value) => value,
  };
}

export function onDiagnosticEvent() {
  return () => undefined;
}
