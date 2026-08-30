<script setup lang="ts">
import { ref, nextTick, watch, computed } from "vue";
import Sidebar from "./components/Sidebar.vue";
import ChangeSetCard from "./components/ChangeSetCard.vue";
import WizardDialog from "./components/WizardDialog.vue";
import {
  state, sendMessage, cancel, pendingApproval, approvePending, rejectPending,
  clearTranscript, activeProvider,
} from "./core/store";

const draft = ref("");
const transcriptEl = ref<HTMLElement | null>(null);
const wizardOpen = ref(false);

const SUGGESTIONS = [
  "Read my config and tell me what stands out",
  "I get propwash on fast descents",
  "The quad feels sluggish on roll",
  "Motors run hot after a pack",
  "Set my rates for smooth cinematic flying",
  "Check my failsafe is sane",
];

const canSend = computed(
  () => !state.busy && draft.value.trim().length > 0 && Boolean(activeProvider.value?.isAuthenticated()),
);

watch(
  () => state.transcript.map((entry) => (entry.kind === "assistant" ? entry.text.length : 0)).join(),
  async () => {
    await nextTick();
    const element = transcriptEl.value;
    if (!element) return;
    // Only follow the stream when the user is already at the bottom.
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 200) {
      element.scrollTop = element.scrollHeight;
    }
  },
);

function submit(): void {
  if (!canSend.value) return;
  const text = draft.value;
  draft.value = "";
  sendMessage(text);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
}

function startWizard(prompt: string): void {
  sendMessage(prompt);
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <h1>Betaflight AI Copilot</h1>
      <span class="badge" :class="state.mode === 'manual' ? 'safe' : 'moderate'">
        {{ state.mode === "manual" ? "manual approve" : state.mode === "autoTune" ? "auto tuning" : "full auto" }}
      </span>
      <span class="spacer"></span>
      <button class="ghost" @click="clearTranscript">New conversation</button>
    </header>

    <Sidebar @wizard="wizardOpen = true" />

    <main class="main">
      <div ref="transcriptEl" class="transcript">
        <div v-if="!state.transcript.length" class="entry system">
          Connect your flight controller and an AI provider, then describe how the quad flies.
          The copilot reads the configuration itself and proposes changes you approve.
          Props off for anything it writes. No quad to hand? Use
          <strong>Try the demo</strong> in the sidebar for a simulated board.
        </div>

        <template v-for="entry in state.transcript" :key="entry.id">
          <div v-if="entry.kind === 'user'" class="entry user">{{ entry.text }}</div>

          <div v-else-if="entry.kind === 'assistant'" class="entry assistant">
            {{ entry.text }}<span v-if="entry.streaming" class="cursor"></span>
          </div>

          <div v-else-if="entry.kind === 'tool'" class="entry tool" :class="entry.state">
            <span>{{ entry.state === "running" ? "▸" : entry.state === "error" ? "✕" : "✓" }}</span>
            <strong>{{ entry.label }}</strong>
            <span>{{ entry.detail }}</span>
          </div>

          <div v-else-if="entry.kind === 'system'" class="entry system" :class="entry.level">
            {{ entry.text }}
          </div>

          <ChangeSetCard
            v-else-if="entry.kind === 'changeset'"
            class="entry"
            :change-set="entry.changeSet"
            :status="entry.status"
            :note="entry.note"
            :awaiting-approval="pendingApproval?.entryId === entry.id"
            @approve="approvePending"
            @reject="rejectPending()"
          />
        </template>
      </div>

      <div class="composer">
        <div v-if="!state.transcript.length" class="suggestions">
          <button v-for="suggestion in SUGGESTIONS" :key="suggestion" @click="draft = suggestion">
            {{ suggestion }}
          </button>
        </div>
        <div class="row">
          <textarea
            v-model="draft"
            rows="1"
            placeholder="Describe how it flies, or ask for a change…"
            @keydown="onKeydown"
          ></textarea>
          <button v-if="state.busy" class="danger" @click="cancel">Stop</button>
          <button v-else class="primary" :disabled="!canSend" @click="submit">Send</button>
        </div>
      </div>
    </main>

    <WizardDialog v-if="wizardOpen" @close="wizardOpen = false" @submit="startWizard" />
  </div>
</template>
