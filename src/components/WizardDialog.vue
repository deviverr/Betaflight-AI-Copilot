<script setup lang="ts">
/**
 * "Build from scratch" wizard: collects what the copilot cannot read off the
 * board — motor kv, prop size, what the aircraft is for — and turns it into an
 * opening instruction for the agent.
 */
import { ref } from "vue";
import { buildWizardPrompt } from "../ai/prompts";

const emit = defineEmits<{ submit: [prompt: string]; close: [] }>();

const spec = ref({
  "Frame size": "5 inch",
  "Battery": "6S",
  "Motors": "",
  "Propellers": "",
  "Flight style": "Freestyle",
  "Receiver": "ELRS / CRSF",
  "VTX": "",
  "Extras": "",
});

const STYLES = ["Freestyle", "Racing", "Cinematic", "Long range", "Tiny whoop", "Cinewhoop"];
const SIZES = ["65mm whoop", "75mm whoop", "3 inch", "4 inch", "5 inch", "7 inch", "10 inch"];
const BATTERIES = ["1S", "2S", "3S", "4S", "6S", "8S"];
const RECEIVERS = ["ELRS / CRSF", "TBS Crossfire / CRSF", "FrSky SBUS", "Ghost / GHST", "Spektrum", "Other"];

function submit(): void {
  emit("submit", buildWizardPrompt(spec.value));
  emit("close");
}
</script>

<template>
  <dialog open>
    <div class="body">
      <h3>Set up a build from scratch</h3>
      <p class="hint">
        Fill in what the flight controller cannot tell the copilot itself. Anything you leave blank
        is simply not assumed.
      </p>

      <div class="field">
        <label>Frame size</label>
        <select v-model="spec['Frame size']">
          <option v-for="size in SIZES" :key="size">{{ size }}</option>
        </select>
      </div>

      <div class="field">
        <label>Battery</label>
        <select v-model="spec['Battery']">
          <option v-for="battery in BATTERIES" :key="battery">{{ battery }}</option>
        </select>
      </div>

      <div class="field">
        <label>Motors (kv and size, e.g. "2207 1960kv")</label>
        <input v-model="spec['Motors']" placeholder="2207 1960kv" />
      </div>

      <div class="field">
        <label>Propellers</label>
        <input v-model="spec['Propellers']" placeholder="5.1x3.1x3 tri-blade" />
      </div>

      <div class="field">
        <label>Flight style</label>
        <select v-model="spec['Flight style']">
          <option v-for="style in STYLES" :key="style">{{ style }}</option>
        </select>
      </div>

      <div class="field">
        <label>Receiver</label>
        <select v-model="spec['Receiver']">
          <option v-for="receiver in RECEIVERS" :key="receiver">{{ receiver }}</option>
        </select>
      </div>

      <div class="field">
        <label>Anything else (GPS, HD system, quirks, past crashes)</label>
        <textarea v-model="spec['Extras']" rows="3"></textarea>
      </div>
    </div>
    <footer>
      <button class="ghost" @click="emit('close')">Cancel</button>
      <button class="primary" @click="submit">Start setup</button>
    </footer>
  </dialog>
</template>
