<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import {
  state, providers, activeProvider, connect, connectDemo, disconnect, refreshConfig,
  selectProvider, loginProvider, setModel, setMode, restoreBackup, loadBlackbox,
} from "../core/store";
import { MODES } from "../core/permissions";
import { downloadBackup, deleteBackup, loadBackups } from "../core/backup";
import { BYOK_PRESETS, type ByokProvider } from "../ai/providers/byok";
import { isWebSerialSupported } from "../msp/serial";

const emit = defineEmits<{ wizard: [] }>();

const serialSupported = isWebSerialSupported();
const providerAvailability = ref<Record<string, boolean>>({});
const dragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const byok = providers.byok as ByokProvider;
const byokDraft = ref({ ...byok.settings });

onMounted(async () => {
  for (const [id, provider] of Object.entries(providers)) {
    providerAvailability.value[id] = await provider.isAvailable();
  }
});

const toolModels = computed(() => state.models.filter((model) => model.supportsTools));
const otherModels = computed(() => state.models.filter((model) => !model.supportsTools));

function saveByok(): void {
  byok.save({ ...byokDraft.value });
  selectProvider("byok");
}

function applyPreset(label: string): void {
  const preset = BYOK_PRESETS.find((entry) => entry.label === label);
  if (preset) byokDraft.value = { ...preset.settings, apiKey: byokDraft.value.apiKey };
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) loadBlackbox(file);
}

function onPick(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) loadBlackbox(file);
}

function removeBackup(id: string): void {
  deleteBackup(id);
  state.backups = loadBackups();
}
</script>

<template>
  <aside class="sidebar">
    <!-- ------------------------------------------------------- connection -->
    <section class="panel">
      <h2>Flight controller</h2>

      <p v-if="!serialSupported" class="hint" style="color: var(--danger)">
        This browser has no Web Serial API. Use Chrome, Edge or Opera on desktop.
      </p>

      <div class="row">
        <span class="status-dot" :class="{ on: state.connected }"></span>
        <span class="grow">
          {{ state.connected ? state.linkMode.toUpperCase() : "Disconnected" }}
        </span>
        <span v-if="state.demo" class="badge moderate">demo</span>
        <button v-if="!state.connected" class="primary" :disabled="!serialSupported || state.connecting" @click="connect">
          {{ state.connecting ? "Connecting…" : "Connect" }}
        </button>
        <button v-else class="ghost" @click="disconnect">Disconnect</button>
      </div>

      <button v-if="!state.connected" :disabled="state.connecting" @click="connectDemo">
        Try the demo — no hardware needed
      </button>
      <p v-if="!state.connected" class="hint">
        The demo is a simulated 5-inch 6S freestyle build. Everything works as it does on a real
        board; nothing is written to hardware.
      </p>

      <dl v-if="state.identity" class="kv">
        <dt>Firmware</dt><dd>{{ state.identity.variant }} {{ state.identity.firmwareVersion }}</dd>
        <dt>Target</dt><dd>{{ state.identity.targetName }}</dd>
        <dt>API</dt><dd>{{ state.identity.apiVersion }}</dd>
        <dt v-if="state.identity.craftName">Craft</dt>
        <dd v-if="state.identity.craftName">{{ state.identity.craftName }}</dd>
      </dl>

      <p v-if="state.connectionError" class="hint" style="color: var(--danger)">
        {{ state.connectionError }}
      </p>

      <div v-if="state.connected" class="row">
        <button class="ghost" :disabled="state.configLoading" @click="refreshConfig(false)">
          {{ state.configLoading ? "Reading…" : "Re-read config" }}
        </button>
        <span v-if="state.config" class="badge">{{ state.config.master.size }} settings</span>
      </div>

      <p v-if="!state.demo" class="hint">
        Close Betaflight Configurator first — only one page can hold the serial port at a time.
      </p>
    </section>

    <!-- --------------------------------------------------------- provider -->
    <section class="panel">
      <h2>AI provider</h2>

      <select :value="state.providerId" @change="selectProvider(($event.target as HTMLSelectElement).value)">
        <option
          v-for="(provider, id) in providers"
          :key="id"
          :value="id"
          :disabled="providerAvailability[id] === false"
        >
          {{ provider.label }}{{ providerAvailability[id] === false ? " (unavailable here)" : "" }}
        </option>
      </select>

      <p class="hint">{{ activeProvider?.description }}</p>

      <template v-if="state.providerId === 'byok'">
        <div class="field">
          <label>Preset</label>
          <select @change="applyPreset(($event.target as HTMLSelectElement).value)">
            <option v-for="preset in BYOK_PRESETS" :key="preset.label">{{ preset.label }}</option>
          </select>
        </div>
        <div class="field">
          <label>Endpoint</label>
          <input v-model="byokDraft.baseUrl" spellcheck="false" />
        </div>
        <div class="field">
          <label>Model</label>
          <input v-model="byokDraft.model" spellcheck="false" />
        </div>
        <div class="field">
          <label>API key (stored in this browser only)</label>
          <input v-model="byokDraft.apiKey" type="password" autocomplete="off" />
        </div>
        <button class="primary" @click="saveByok">Save</button>
      </template>

      <div class="row" v-else>
        <button v-if="!state.authenticated" class="primary" @click="loginProvider">
          Connect {{ activeProvider?.label }}
        </button>
        <template v-else>
          <span class="status-dot on"></span>
          <span class="grow">Connected</span>
          <button class="ghost" @click="activeProvider.logout(); state.authenticated = false">
            Sign out
          </button>
        </template>
      </div>

      <p v-if="state.providerError" class="hint" style="color: var(--danger)">{{ state.providerError }}</p>

      <div v-if="state.models.length" class="field">
        <label>Model</label>
        <select :value="state.model" @change="setModel(($event.target as HTMLSelectElement).value)">
          <optgroup label="Can use tools (full copilot)">
            <option v-for="model in toolModels" :key="model.id" :value="model.id">{{ model.label }}</option>
          </optgroup>
          <optgroup v-if="otherModels.length" label="Advisory only (no tool calling)">
            <option v-for="model in otherModels" :key="model.id" :value="model.id">{{ model.label }}</option>
          </optgroup>
        </select>
      </div>
    </section>

    <!-- ------------------------------------------------------ permissions -->
    <section class="panel">
      <h2>Permission mode</h2>
      <select :value="state.mode" @change="setMode(($event.target as HTMLSelectElement).value as any)">
        <option v-for="mode in MODES" :key="mode.id" :value="mode.id">{{ mode.label }}</option>
      </select>
      <p class="hint">{{ MODES.find((mode) => mode.id === state.mode)?.description }}</p>
      <p class="hint">
        Resource, timer, mixer and <code>defaults</code> changes always ask. Motor spin, flash erase
        and bootloader commands are never issued in any mode.
      </p>
    </section>

    <!-- --------------------------------------------------------- blackbox -->
    <section class="panel">
      <h2>Blackbox log</h2>
      <div
        class="dropzone"
        :class="{ over: dragging }"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
        @click="fileInput?.click()"
      >
        Drop a <code>.bbl</code> or <code>.csv</code> log here
      </div>
      <input ref="fileInput" type="file" accept=".bbl,.bfl,.txt,.csv" hidden @change="onPick" />

      <dl v-if="state.blackbox" class="kv">
        <dt>File</dt><dd>{{ state.blackbox.fileName }}</dd>
        <dt>Frames</dt><dd>{{ state.blackbox.frameCount }}</dd>
        <dt>Length</dt><dd>{{ state.blackbox.durationSeconds.toFixed(1) }} s</dd>
        <dt>Rate</dt><dd>{{ state.blackbox.sampleRateHz.toFixed(0) }} Hz</dd>
      </dl>
      <p v-if="state.blackbox?.headerOnly" class="hint" style="color: var(--warn)">
        Header only — export CSV for the full analysis.
      </p>
    </section>

    <!-- ---------------------------------------------------------- backups -->
    <section class="panel">
      <h2>Backups ({{ state.backups.length }})</h2>
      <p class="hint">One is taken automatically before every write.</p>
      <div class="list scroll-y" style="max-height: 200px">
        <div v-for="backup in state.backups" :key="backup.id" class="list-item">
          <span class="grow" :title="backup.label">{{ backup.label }}</span>
          <button class="ghost" title="Download" @click="downloadBackup(backup)">↓</button>
          <button
            class="ghost"
            title="Restore to the flight controller"
            :disabled="!state.connected"
            @click="restoreBackup(backup)"
          >
            ↺
          </button>
          <button class="ghost danger" title="Delete" @click="removeBackup(backup.id)">×</button>
        </div>
      </div>
    </section>

    <button @click="emit('wizard')">Set up a build from scratch…</button>
  </aside>
</template>
