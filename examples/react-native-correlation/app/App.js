import { useEffect, useMemo, useRef, useState } from 'react'
import { Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as Crypto from 'expo-crypto'
import { createTracedClient, formatAttemptLine } from '../correlation'

// Same scenarios as node-client.js, so a phone session and a Node session can be compared.
const SCENARIOS = [
  { label: 'list (small)', path: '/api/items' },
  { label: 'list (large)', path: '/api/items?size=large' },
  { label: 'slow list', path: '/api/items/slow' },
  { label: 'flaky, with retry', path: '/api/flaky', maxAttempts: 3 },
  { label: 'stall, client gives up', path: '/api/stall', timeoutMs: 800 }
]

// The Android emulator reaches the host machine's loopback at 10.0.2.2; the iOS simulator shares it directly.
// A physical phone needs the computer's LAN address and a server started with HOST=0.0.0.0.
const DEFAULT_BASE_URL = Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://127.0.0.1:4000'

const now = () => globalThis.performance.now()
const fmt = (n) => (n === null || n === undefined ? '-' : `${n.toFixed(1)} ms`)

export default function App () {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [runs, setRuns] = useState([])
  const [busy, setBusy] = useState(false)
  const pending = useRef(null)

  const client = useMemo(() => createTracedClient({
    baseUrl,
    newId: () => Crypto.randomUUID(),
    now,
    // One line per attempt in the Metro console; join-cli.js picks these lines out of the copied console text.
    onAttempt: (attempt) => console.log(formatAttemptLine(attempt))
  }), [baseUrl])

  // operationMs: tap until the first frame after React committed the result. This is a proxy for "the user can
  // see it", not a measurement of pixels on screen; it excludes any later image decoding or layout work.
  useEffect(() => {
    const p = pending.current
    if (p === null) return
    pending.current = null
    requestAnimationFrame(() => {
      const operationMs = now() - p.tapAt
      setRuns((rs) => rs.map((r) => (r.key === p.key ? { ...r, operationMs } : r)))
    })
  }, [runs])

  async function run (scenario) {
    if (busy) return
    setBusy(true)
    const tapAt = now()
    try {
      const result = await client.request(scenario.path, {
        operationName: scenario.label,
        maxAttempts: scenario.maxAttempts,
        timeoutMs: scenario.timeoutMs
      })
      const key = result.operation.operationId
      pending.current = { key, tapAt }
      setRuns((rs) => [{
        key,
        label: scenario.label,
        outcome: result.operation.outcome,
        items: Array.isArray(result.data?.items) ? result.data.items.length : null,
        attempts: result.operation.attempts,
        operationMs: null
      }, ...rs].slice(0, 20))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style='auto' />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>express-observe correlation</Text>
        <Text style={styles.label}>API base URL</Text>
        <TextInput
          style={styles.input}
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize='none'
          autoCorrect={false}
          keyboardType='url'
        />
        <View style={styles.buttons}>
          {SCENARIOS.map((s) => (
            <Pressable key={s.label} onPress={() => run(s)} disabled={busy} style={[styles.button, busy && styles.disabled]}>
              <Text style={styles.buttonText}>{s.label}</Text>
            </Pressable>
          ))}
        </View>

        {runs.map((r) => (
          <View key={r.key} style={styles.card}>
            <Text style={styles.cardTitle}>{r.label}: {r.outcome}{r.items !== null ? `, ${r.items} items` : ''}</Text>
            <Text>operation (tap to next frame after commit, proxy): {fmt(r.operationMs)}</Text>
            {r.attempts.map((a) => (
              <Text key={a.requestId} style={styles.attempt}>
                try {a.attempt}: {a.status ?? a.outcome}, client {fmt(a.clientAttemptMs)}, server app {fmt(a.serverAppMs)}
                {'\n'}id {a.requestId.slice(0, 8)}{a.requestIdEchoed ? ' (echoed by server)' : ''}
              </Text>
            ))}
          </View>
        ))}

        <Text style={styles.note}>
          "server app" is the server's time until it sent headers, read from Server-Timing. The difference to the
          client time is not network time: it also contains connection setup, queueing, transfer, JSON parsing and,
          in React Native, the whole body download before fetch resolves. Join the console lines with the server log
          (join-cli.js) to see the server's total time and interrupted requests.
        </Text>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12 },
  title: { fontSize: 20, fontWeight: '600' },
  label: { fontSize: 13, opacity: 0.7 },
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 6, padding: 8 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { backgroundColor: '#2f5d8a', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  disabled: { opacity: 0.5 },
  buttonText: { color: 'white' },
  card: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 10, gap: 4 },
  cardTitle: { fontWeight: '600' },
  attempt: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 },
  note: { fontSize: 12, opacity: 0.7 }
})
