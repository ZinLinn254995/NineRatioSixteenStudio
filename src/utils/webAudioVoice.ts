import type { VoiceSettings } from "../types";

// Sample-accurate dual-tap granular pitch shifter + ring-mod robot AudioWorklet code
const WORKLET_CODE = `
class VoiceChangerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pitchSemitones", defaultValue: 0, minValue: -12, maxValue: 12, automationRate: "k-rate" },
      { name: "robotAmount", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }
    ];
  }

  constructor() {
    super();
    this.bufSize = 8192;
    this.mask = this.bufSize - 1;
    this.grainSize = 2048;
    this.buffers = [new Float32Array(this.bufSize), new Float32Array(this.bufSize)];
    this.writeIndex = 0;
    this.phase = 0;
    this.robotPhase = 0;
  }

  readTap(buf, delaySamples) {
    const pos = this.writeIndex - delaySamples;
    const i0 = Math.floor(pos) & this.mask;
    const i1 = (i0 + 1) & this.mask;
    const frac = pos - Math.floor(pos);
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }

    const pitchSemi = parameters.pitchSemitones[0];
    const robotAmt = parameters.robotAmount[0];
    const pitchActive = Math.abs(pitchSemi) >= 0.08;
    const ratio = pitchActive ? Math.pow(2, pitchSemi / 12) : 1;
    const phaseInc = pitchActive ? (1 - ratio) / this.grainSize : 0;
    const robotFreq = 58 / sampleRate;

    const chCount = Math.min(output.length, 2);
    const frameCount = output[0].length;

    for (let i = 0; i < frameCount; i++) {
      let ph = this.phase;
      let dA = ph * this.grainSize;
      let phB = ph + 0.5;
      if (phB >= 1) phB -= 1;
      let dB = phB * this.grainSize;
      // Hann crossfade weights aligned so wA=0 when ph wraps at 0/1 and wB=0 when phB wraps
      const wA = 0.5 * (1 - Math.cos(2 * Math.PI * ph));
      const wB = 1 - wA;

      this.robotPhase += robotFreq;
      if (this.robotPhase >= 1) this.robotPhase -= 1;
      const robotMod = Math.sin(2 * Math.PI * this.robotPhase);

      for (let ch = 0; ch < chCount; ch++) {
        const inChan = input[ch] || input[0];
        const x = inChan[i] || 0;
        const buf = this.buffers[ch];
        buf[this.writeIndex] = x;

        let sample = pitchActive
          ? this.readTap(buf, dA) * wA + this.readTap(buf, dB) * wB
          : x;

        if (robotAmt > 0.01) {
          const ring = sample * robotMod;
          sample = sample * (1 - robotAmt * 0.85) + ring * (robotAmt * 1.15);
        }

        output[ch][i] = sample;
      }

      this.writeIndex = (this.writeIndex + 1) & this.mask;
      if (pitchActive) {
        ph += phaseInc;
        while (ph < 0) ph += 1;
        while (ph >= 1) ph -= 1;
        this.phase = ph;
      }
    }

    return true;
  }
}

registerProcessor("voice-changer-processor", VoiceChangerProcessor);
`;

const activeContexts = new Set<AudioContext>();

export function resumeAllVoiceContexts(): void {
  activeContexts.forEach((ctx) => {
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  });
}

class RealTimeVoiceProcessor {
  private ctx: AudioContext;
  private source: MediaElementAudioSourceNode;
  private preNode: GainNode;
  private postNode: GainNode;

  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private workletReady = false;
  private latestSettings: VoiceSettings = {
    presetId: "original",
    pitchSemitones: 0,
    speed: 1,
    tone: 0,
    echo: 0,
    robot: 0,
  };

  private bassFilter: BiquadFilterNode;
  private trebleFilter: BiquadFilterNode;
  private dryOutGain: GainNode;
  private echoDelay: DelayNode;
  private echoFeedback: GainNode;
  private echoWetGain: GainNode;

  constructor(videoEl: HTMLVideoElement) {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx();
    activeContexts.add(this.ctx);

    this.source = this.ctx.createMediaElementSource(videoEl);
    this.preNode = this.ctx.createGain();
    this.postNode = this.ctx.createGain();

    // Direct bypass until AudioWorklet loads (<5ms)
    this.source.connect(this.preNode);
    this.preNode.connect(this.postNode);

    // Tone EQ stage
    this.bassFilter = this.ctx.createBiquadFilter();
    this.bassFilter.type = "lowshelf";
    this.bassFilter.frequency.value = 220;

    this.trebleFilter = this.ctx.createBiquadFilter();
    this.trebleFilter.type = "highshelf";
    this.trebleFilter.frequency.value = 3200;

    // Echo stage
    this.dryOutGain = this.ctx.createGain();
    this.dryOutGain.gain.value = 1;
    this.echoDelay = this.ctx.createDelay(1.0);
    this.echoDelay.delayTime.value = 0.18;
    this.echoFeedback = this.ctx.createGain();
    this.echoFeedback.gain.value = 0.35;
    this.echoWetGain = this.ctx.createGain();
    this.echoWetGain.gain.value = 0;

    this.postNode.connect(this.bassFilter);
    this.bassFilter.connect(this.trebleFilter);

    this.trebleFilter.connect(this.dryOutGain);
    this.dryOutGain.connect(this.ctx.destination);

    this.trebleFilter.connect(this.echoDelay);
    this.echoDelay.connect(this.echoFeedback);
    this.echoFeedback.connect(this.echoDelay);
    this.echoDelay.connect(this.echoWetGain);
    this.echoWetGain.connect(this.ctx.destination);

    this.initPitchProcessor();
  }

  private async initPitchProcessor() {
    if (this.ctx.audioWorklet) {
      try {
        const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        try {
          await this.ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }

        const node = new AudioWorkletNode(this.ctx, "voice-changer-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });

        this.preNode.disconnect(this.postNode);
        this.preNode.connect(node);
        node.connect(this.postNode);
        this.workletNode = node;
        this.workletReady = true;
        this.applySettings(this.latestSettings);
        return;
      } catch {
        // Fall through to ScriptProcessor fallback
      }
    }

    // Fallback for environments without AudioWorklet
    try {
      const bufSize = 8192;
      const mask = bufSize - 1;
      const grainSize = 2048;
      const bufs = [new Float32Array(bufSize), new Float32Array(bufSize)];
      let writeIdx = 0;
      let phase = 0;
      let robotPhase = 0;

      const readTap = (buf: Float32Array, d: number) => {
        const pos = writeIdx - d;
        const i0 = Math.floor(pos) & mask;
        const i1 = (i0 + 1) & mask;
        const frac = pos - Math.floor(pos);
        return buf[i0] * (1 - frac) + buf[i1] * frac;
      };

      const sp = this.ctx.createScriptProcessor(1024, 2, 2);
      sp.onaudioprocess = (ev) => {
        const pitchSemi = this.latestSettings.pitchSemitones;
        const robotAmt = Math.max(0, Math.min(1, this.latestSettings.robot / 100));
        const pitchActive = Math.abs(pitchSemi) >= 0.08;
        const ratio = pitchActive ? Math.pow(2, pitchSemi / 12) : 1;
        const phaseInc = pitchActive ? (1 - ratio) / grainSize : 0;
        const robotFreq = 58 / this.ctx.sampleRate;

        const inL = ev.inputBuffer.getChannelData(0);
        const inR = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : inL;
        const outL = ev.outputBuffer.getChannelData(0);
        const outR = ev.outputBuffer.getChannelData(1);

        for (let i = 0; i < inL.length; i++) {
          let ph = phase;
          const dA = ph * grainSize;
          let phB = ph + 0.5;
          if (phB >= 1) phB -= 1;
          const dB = phB * grainSize;
          const wA = 0.5 * (1 - Math.cos(2 * Math.PI * ph));
          const wB = 1 - wA;

          robotPhase += robotFreq;
          if (robotPhase >= 1) robotPhase -= 1;
          const mod = Math.sin(2 * Math.PI * robotPhase);

          bufs[0][writeIdx] = inL[i];
          bufs[1][writeIdx] = inR[i];

          let sL = pitchActive ? readTap(bufs[0], dA) * wA + readTap(bufs[0], dB) * wB : inL[i];
          let sR = pitchActive ? readTap(bufs[1], dA) * wA + readTap(bufs[1], dB) * wB : inR[i];

          if (robotAmt > 0.01) {
            sL = sL * (1 - robotAmt * 0.85) + sL * mod * (robotAmt * 1.15);
            sR = sR * (1 - robotAmt * 0.85) + sR * mod * (robotAmt * 1.15);
          }

          outL[i] = sL;
          outR[i] = sR;

          writeIdx = (writeIdx + 1) & mask;
          if (pitchActive) {
            ph += phaseInc;
            while (ph < 0) ph += 1;
            while (ph >= 1) ph -= 1;
            phase = ph;
          }
        }
      };

      this.preNode.disconnect(this.postNode);
      this.preNode.connect(sp);
      sp.connect(this.postNode);
      this.scriptNode = sp;
      this.workletReady = true;
    } catch {
      // Keep clean bypass
    }
  }

  public resume() {
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
  }

  public applySettings(settings: VoiceSettings) {
    this.latestSettings = { ...settings };
    const now = this.ctx.currentTime;

    if (this.workletReady && this.workletNode) {
      const pitchParam = this.workletNode.parameters.get("pitchSemitones");
      const robotParam = this.workletNode.parameters.get("robotAmount");
      pitchParam?.setValueAtTime(settings.pitchSemitones, now);
      robotParam?.setValueAtTime(Math.max(0, Math.min(1, settings.robot / 100)), now);
    }

    // Tone shaping
    const bassDb = settings.tone < 0 ? Math.abs(settings.tone) * 1.3 : -settings.tone * 0.45;
    const trebleDb = settings.tone > 0 ? settings.tone * 1.3 : -Math.abs(settings.tone) * 0.35;
    this.bassFilter.gain.setTargetAtTime(bassDb, now, 0.02);
    this.trebleFilter.gain.setTargetAtTime(trebleDb, now, 0.02);

    // Echo wet mix & feedback
    const echoAmt = Math.max(0, Math.min(1, settings.echo / 100));
    this.echoDelay.delayTime.setTargetAtTime(0.08 + echoAmt * 0.16, now, 0.02);
    this.echoFeedback.gain.setTargetAtTime(0.15 + echoAmt * 0.45, now, 0.02);
    this.echoWetGain.gain.setTargetAtTime(echoAmt * 0.65, now, 0.02);
  }
}

const processorMap = new WeakMap<HTMLVideoElement, RealTimeVoiceProcessor>();

export function applyVoiceEffectsToVideoElement(
  videoEl: HTMLVideoElement,
  settings: VoiceSettings,
  isPlaying: boolean
): void {
  let proc = processorMap.get(videoEl);
  if (!proc) {
    try {
      proc = new RealTimeVoiceProcessor(videoEl);
      processorMap.set(videoEl, proc);
    } catch {
      return;
    }
  }
  if (isPlaying) {
    proc.resume();
  }
  proc.applySettings(settings);
}
