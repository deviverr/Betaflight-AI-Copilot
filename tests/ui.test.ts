import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import App from "../src/App.vue";
import ChangeSetCard from "../src/components/ChangeSetCard.vue";
import WizardDialog from "../src/components/WizardDialog.vue";
import { parseConfig } from "../src/core/config";
import { newChangeSet, resolveChange } from "../src/core/changeset";
import { state, clearTranscript, pushSystem } from "../src/core/store";

const config = parseConfig("# master\nset p_pitch = 47\n");

beforeEach(() => {
  clearTranscript();
  state.connected = false;
  state.models = [];
  state.busy = false;
});

describe("App", () => {
  it("mounts and shows the empty state", () => {
    const wrapper = mount(App);
    expect(wrapper.text()).toContain("Betaflight AI Copilot");
    expect(wrapper.text()).toContain("Connect your flight controller");
  });

  it("warns when the browser has no Web Serial API", () => {
    // happy-dom has no navigator.serial, which is exactly the unsupported case.
    expect(mount(App).text()).toContain("no Web Serial API");
  });

  it("renders the permission mode in the top bar", () => {
    const wrapper = mount(App);
    expect(wrapper.text()).toContain("manual approve");
  });

  it("renders transcript entries of every kind", async () => {
    pushSystem("something went wrong", "error");
    state.transcript.push({ id: "u1", kind: "user", text: "why does it wobble" });
    state.transcript.push({ id: "a1", kind: "assistant", text: "Because of D.", streaming: false });
    state.transcript.push({ id: "t1", kind: "tool", label: "read_config", detail: "…", state: "done" });

    const wrapper = mount(App);
    await wrapper.vm.$nextTick();
    const text = wrapper.text();
    expect(text).toContain("something went wrong");
    expect(text).toContain("why does it wobble");
    expect(text).toContain("Because of D.");
    expect(text).toContain("read_config");
  });

  it("keeps Send disabled until a provider is authenticated", async () => {
    const wrapper = mount(App);
    await wrapper.find("textarea").setValue("hello");
    const send = wrapper.findAll("button").find((button) => button.text() === "Send")!;
    expect(send.attributes("disabled")).toBeDefined();
  });
});

describe("ChangeSetCard", () => {
  const changeSet = newChangeSet("Raise P on pitch", "Sharper response.", [
    resolveChange(config, { kind: "set", key: "p_pitch", value: "52", reason: "more authority" }),
  ]);

  it("shows the diff, the reason and the risk badge", () => {
    const wrapper = mount(ChangeSetCard, {
      props: { changeSet, status: "pending", note: "waiting", awaitingApproval: true },
    });
    expect(wrapper.text()).toContain("p_pitch: 47 → 52");
    expect(wrapper.text()).toContain("more authority");
    expect(wrapper.text()).toContain("safe");
  });

  it("offers approve and reject only while awaiting approval", () => {
    const pending = mount(ChangeSetCard, {
      props: { changeSet, status: "pending", note: "", awaitingApproval: true },
    });
    expect(pending.findAll("button").map((b) => b.text())).toContain("Apply & save");

    const applied = mount(ChangeSetCard, {
      props: { changeSet, status: "applied", note: "", awaitingApproval: false },
    });
    expect(applied.findAll("button").map((b) => b.text())).not.toContain("Apply & save");
  });

  it("emits approve and reject", async () => {
    const wrapper = mount(ChangeSetCard, {
      props: { changeSet, status: "pending", note: "", awaitingApproval: true },
    });
    await wrapper.findAll("button").find((b) => b.text() === "Apply & save")!.trigger("click");
    await wrapper.findAll("button").find((b) => b.text() === "Reject")!.trigger("click");
    expect(wrapper.emitted("approve")).toHaveLength(1);
    expect(wrapper.emitted("reject")).toHaveLength(1);
  });

  it("reveals the exact CLI that will be sent", async () => {
    const wrapper = mount(ChangeSetCard, {
      props: { changeSet, status: "pending", note: "", awaitingApproval: true },
    });
    await wrapper.findAll("button").find((b) => b.text() === "Show CLI")!.trigger("click");
    const cli = wrapper.find("pre").text();
    expect(cli).toContain("set p_pitch = 52");
    expect(cli.trim().endsWith("save")).toBe(true);
  });
});

describe("WizardDialog", () => {
  it("turns the form into an opening instruction", async () => {
    const wrapper = mount(WizardDialog);
    await wrapper.findAll("input")[0].setValue("2207 1960kv");
    await wrapper.findAll("button").find((b) => b.text() === "Start setup")!.trigger("click");

    const [[prompt]] = wrapper.emitted("submit") as [string][];
    expect(prompt).toContain("2207 1960kv");
    expect(prompt).toContain("Frame size: 5 inch");
    expect(prompt).toContain("receiver and failsafe");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("omits fields the user left blank", async () => {
    const wrapper = mount(WizardDialog);
    await wrapper.findAll("button").find((b) => b.text() === "Start setup")!.trigger("click");
    const [[prompt]] = wrapper.emitted("submit") as [string][];
    expect(prompt).not.toContain("Propellers:");
    expect(prompt).not.toContain("Extras:");
  });
});

describe("suggestions", () => {
  it("fills the composer when a suggestion is clicked", async () => {
    const wrapper = mount(App);
    const suggestion = wrapper.findAll(".suggestions button")[0];
    const label = suggestion.text();
    await suggestion.trigger("click");
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe(label);
  });
});
