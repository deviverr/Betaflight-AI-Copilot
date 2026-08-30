<script setup lang="ts">
import { computed } from "vue";
import { renderDiff, toCliCommands } from "../core/changeset";
import type { ChangeSet } from "../core/changeset";
import type { ApprovalStatus } from "../core/store";

const props = defineProps<{
  changeSet: ChangeSet;
  status: ApprovalStatus;
  note: string;
  awaitingApproval: boolean;
}>();

const emit = defineEmits<{ approve: []; reject: [] }>();

const rows = computed(() => renderDiff(props.changeSet));
const reasons = computed(() => props.changeSet.changes.map((change) => change.reason));
const commands = computed(() => toCliCommands(props.changeSet).join("\n"));
const showCli = defineModel<boolean>("showCli", { default: false });

const statusLabel: Record<ApprovalStatus, string> = {
  pending: "Waiting for you",
  applied: "Applied and saved",
  rejected: "Rejected",
  failed: "Failed",
  refused: "Refused",
};
</script>

<template>
  <div class="changeset" :class="status">
    <header>
      <strong>{{ changeSet.title }}</strong>
      <span class="badge" :class="changeSet.changes[0]?.risk">{{ statusLabel[status] }}</span>
      <span style="flex: 1"></span>
      <button class="ghost" @click="showCli = !showCli">
        {{ showCli ? "Hide CLI" : "Show CLI" }}
      </button>
    </header>

    <p v-if="changeSet.summary" class="summary">{{ changeSet.summary }}</p>

    <ul class="diff-list">
      <template v-for="(row, index) in rows" :key="index">
        <li>
          <span class="scope">{{ row.scope }}</span>
          <span>{{ row.text }}</span>
          <span class="badge" :class="row.risk">{{ row.risk }}</span>
        </li>
        <li v-if="reasons[index]"><span></span><span class="reason">{{ reasons[index] }}</span></li>
      </template>
    </ul>

    <pre v-if="showCli">{{ commands }}</pre>

    <footer>
      <span class="note">{{ note }}</span>
      <template v-if="awaitingApproval">
        <button class="ghost" @click="emit('reject')">Reject</button>
        <button class="primary" @click="emit('approve')">Apply &amp; save</button>
      </template>
    </footer>
  </div>
</template>
