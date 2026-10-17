'use strict'

// analyze: rules that keep the report from claiming more than the log supports (ADR-0004 and addendum).
module.exports = {
  title: 'analyze: honesty and data quality',
  tests: ['test/analyze.test.js'],
  mutations: [
    {
      name: 'interrupted durations included in latency percentiles',
      file: 'src/analyze.js',
      from: "  if (record.termination === 'interrupted') {\n    group.interrupted++\n    return\n  }\n",
      to: "  if (record.termination === 'interrupted') group.interrupted++\n"
    },
    { name: 'p95 shown below the minimum sample count', file: 'src/analyze.js', from: '      p95: n >= MIN_SAMPLES.p95 ? round3(at(95)) : null,', to: '      p95: n > 0 ? round3(at(95)) : null,' },
    { name: 'a bad line in the middle reported as a truncated end', file: 'src/analyze.js', from: '    lastLineNotJson = false\n', to: '' },
    { name: 'UTF-16 input not detected', file: 'src/analyze.js', from: "      if (text.includes('\\u0000')) nulLines++\n", to: '' },
    { name: 'coverage note removed', file: 'src/analyze.js', from: "  notes.push('This report describes the records in this input only.", to: "  if (false) notes.push('This report describes the records in this input only." },
    { name: 'unsupported schemaVersion read as version 1', file: 'src/analyze.js', from: '  if (value.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return { skip: \'unsupportedSchema\' }\n', to: '' }
,
    { name: 'no cap on distinct field values', file: 'src/analyze.js', from: '        if (fieldValues.size >= MAX_FIELD_VALUES) {', to: '        if (false) {' },
    { name: 'core fields accepted for field grouping', file: 'src/analyze.js', from: '    if (CORE_FIELDS.includes(name)) throw', to: '    if (false) throw' },
    { name: 'inherited properties read as field values', file: 'src/analyze.js', from: 'Object.hasOwn(record, fieldName) ? record[fieldName] : undefined', to: 'record[fieldName]' },
    { name: 'field grouping mixes routes', file: 'src/analyze.js', from: '  if (fieldPart !== null) return `${record.method} ${record.route ?? UNKNOWN_ROUTE}  ${fieldPart}`', to: '  if (fieldPart !== null) return fieldPart' }
  ]
}
