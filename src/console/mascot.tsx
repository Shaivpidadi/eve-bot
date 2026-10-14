"use client";

import { useEffect, useRef, useState } from "react";

import { Avatar, faceOf } from "./avatar";
import type { Member, Presence } from "./types";

/**
 * A member's face, alive: a small raymarched WebGL gummy in the same shape and
 * colour as its SVG avatar, with eyes in front and a little bum behind.
 *
 * Drag it to spin it round (it jiggles as it turns, and swings back to face
 * you a moment after you let go); tap it for a squish. It moves by mood:
 *
 * - Idle: breathes, turns to follow your pointer with its eyes and body, blinks now and then.
 * - Thinking: sways side to side, eyes circling up and away.
 * - Working: hops, squashing on landing and stretching on the way up.
 * - Waiting (needs you): sways, eyes wide and on you.
 * - Blocked: an uneasy shudder every few seconds, eyes narrowed.
 * - Done: happy arc eyes, a bounce, and now and then a twirl.
 * - Paused: eyes shut, slow breathing, colour drained.
 *
 * One canvas, drawn only while it is on screen and the page is visible; with
 * reduced motion it holds still unless you turn it; where WebGL is missing it
 * is the SVG avatar.
 */

const VERTEX = `
attribute vec2 a;
varying vec2 v;
void main() { v = a; gl_Position = vec4(a, 0.0, 1.0); }
`;

const FRAGMENT = `
precision highp float;
varying vec2 v;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uColor;
uniform float uShape;
uniform float uEyeY;
uniform float uSeat;
uniform vec2 uCenter;
uniform vec2 uOffset;
uniform vec2 uScale;
uniform float uLean;
uniform float uWobble;
uniform float uYaw;
uniform float uJiggle;
uniform float uPitch;
uniform vec2 uGaze;
uniform float uOpen;
uniform float uMood;
uniform float uSat;
uniform float uSide;

const float FRAME = 1.32;
const float RIM = 0.3;

float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
float sdHexagon(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p); p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy; p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}
float sdTriangle(vec2 p, float r) {
  const float k = 1.7320508;
  p.x = abs(p.x) - r; p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}
float sdUnevenCapsule(vec2 p, float r1, float r2, float h) {
  p.x = abs(p.x); float b = (r1 - r2) / h; float a = sqrt(1.0 - b * b); float k = dot(p, vec2(-b, a));
  if (k < 0.0) return length(p) - r1;
  if (k > a * h) return length(p - vec2(0.0, h)) - r2;
  return dot(p, vec2(a, b)) - r1;
}

/** The outline, as in the SVG avatar. */
float outline(vec2 p) {
  if (uShape < 0.5) return length(p) - 0.82;
  if (uShape < 1.5) return sdHexagon(p.yx, 0.54) - 0.14;
  if (uShape < 2.5) return sdTriangle(p - vec2(0.0, -0.22), 0.66) - 0.15;
  if (uShape < 3.5) {
    float d = sdRoundBox(p - vec2(0.0, -0.36), vec2(0.82, 0.26), 0.26);
    d = smin(d, length(p - vec2(-0.4, -0.12)) - 0.36, 0.18);
    d = smin(d, length(p - vec2(0.02, 0.16)) - 0.5, 0.18);
    d = smin(d, length(p - vec2(0.44, -0.1)) - 0.36, 0.18);
    return d;
  }
  if (uShape < 4.5) return sdUnevenCapsule(p - vec2(0.0, -0.25), 0.63, 0.05, 1.02);
  if (uShape < 5.5) return sdRoundBox(p, vec2(0.76), 0.46);
  return sdRoundBox(p - vec2(0.0, -0.03), vec2(0.86, 0.56), 0.56);
}

/** How far each face bulges at p: one smooth dome over the whole body, so no
 *  crease from the outline's corners ever reaches the skin. */
float puff(vec2 p) { vec2 c = p - uCenter; return 0.17 * clamp(1.0 - dot(c, c) / 0.8, 0.0, 1.0); }

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float seatZ;

/** The outline inflated into a gummy, with two round cheeks on its back. */
float gummy(vec3 q) {
  float d = outline(q.xy);
  vec2 w = vec2(d + RIM, abs(q.z) - puff(q.xy));
  float f = min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - RIM;
  vec3 c = q - vec3(0.0, uSeat, -seatZ + 0.1);
  float cheeks = min(length(c - vec3(0.165, 0.0, 0.0)), length(c + vec3(0.165, 0.0, 0.0))) - 0.2;
  return smin(f, cheeks, 0.1);
}

/** From the world into the gummy's own space: hop, lean, squash, spin with a jelly lag, wobble. */
vec3 local(vec3 p) {
  p.xy -= uOffset;
  p.xy = rot(uLean) * (p.xy + vec2(0.0, 0.8)) - vec2(0.0, 0.8);
  p.x /= uScale.x; p.z /= uScale.x;
  p.y = (p.y + 0.82) / uScale.y - 0.82;
  // The top lags the base as it turns, and overshoots when it stops.
  p.xz = rot(uYaw + uJiggle * (p.y + 0.85)) * p.xz;
  p.x += uWobble * 0.016 * sin(p.y * 5.0 + uTime * 3.1);
  p.y += uWobble * 0.012 * sin(p.x * 4.2 + uTime * 2.4);
  return p;
}

float map(vec3 p) { return gummy(local(p)) * min(uScale.x, uScale.y) * 0.8; }

vec3 normalAt(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.003;
  return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) + k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}

float eye(vec2 q) {
  float open = max(uOpen, 0.0);
  if (uMood > 1.5) { // asleep: a closed, downturned lid
    float c = abs(length(q - vec2(0.0, 0.08)) - 0.12) - 0.03;
    return max(c, q.y - 0.03);
  }
  if (uMood > 0.5) { // happy: an upturned arc
    float c = abs(length(q - vec2(0.0, -0.07)) - 0.12) - 0.032;
    return max(c, -q.y - 0.02);
  }
  float squint = uMood < -0.5 ? 0.62 : 1.0;
  float h = max(0.19 * open * squint, 0.02);
  return sdRoundBox(q, vec2(0.088, h), min(0.088, h));
}

void main() {
  vec2 p0 = v * FRAME;
  float px = 2.0 * FRAME / uRes.y;
  seatZ = RIM + puff(vec2(0.0, uSeat));

  // A soft contact shadow, smaller and fainter as it leaves the ground.
  float lift = clamp(uOffset.y * 6.0, 0.0, 1.0);
  vec2 sq = (p0 - vec2(uOffset.x, -0.95)) / vec2(0.6 * (1.0 - 0.35 * lift) * uScale.x, 0.08);
  float shadow = exp(-dot(sq, sq) * 1.6) * (0.22 - 0.13 * lift);

  // An orthographic camera, tipped to look a little down on it.
  vec3 ro = vec3(p0, 1.4);
  vec3 rd = vec3(0.0, 0.0, -1.0);
  ro.yz = rot(-uPitch) * ro.yz;
  rd.yz = rot(-uPitch) * rd.yz;

  float t = 0.0;
  float closest = 1e3;
  bool hit = false;
  for (int i = 0; i < 80; i++) {
    float d = map(ro + rd * t);
    closest = min(closest, d);
    if (d < 0.0012) { hit = true; break; }
    t += d;
    if (t > 2.8) break;
  }
  float cover = hit ? 1.0 : 1.0 - smoothstep(0.0, px * 0.8, closest);
  if (cover <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, shadow); return; }

  vec3 pos = ro + rd * t;
  vec3 n = normalAt(pos);
  vec3 view = -rd;
  vec3 light = normalize(vec3(-0.5, 0.75, 0.65));
  vec3 base = mix(vec3(dot(uColor, vec3(0.299, 0.587, 0.114))), uColor, uSat);

  // Gummy: deep, saturated colour in the body; light glowing through where it is
  // thin; a glassy rim and a sharp highlight on the skin.
  float wrap = clamp((dot(n, light) + 0.45) / 1.45, 0.0, 1.0);
  float thick = clamp(-map(pos - n * 0.32) / 0.32, 0.0, 1.0);
  float glow = 1.0 - thick;
  float fres = pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 3.0);
  float spec = pow(max(dot(n, normalize(light + view)), 0.0), 70.0);
  float sheen = pow(max(dot(n, normalize(vec3(0.7, -0.2, 0.6) + view)), 0.0), 12.0);
  float ao = clamp(0.35 + map(pos + n * 0.06) / 0.06 * 0.65, 0.0, 1.0);

  vec3 deep = base * base * 0.85;
  vec3 col = mix(deep, base * 1.02, wrap);
  col += mix(base, vec3(1.0), 0.3) * glow * 0.32;
  col += base * 0.14 * clamp(-n.y, 0.0, 1.0);
  col *= ao;
  col += mix(base, vec3(1.0), 0.55) * fres * 0.4;
  col += vec3(1.0) * (spec * 0.95 + sheen * 0.08);

  // The face, painted on the front so it turns with the body.
  vec3 q = local(pos);
  float front = smoothstep(0.02, 0.14, q.z);
  vec2 g = uGaze * vec2(0.1, 0.075);
  vec2 eyeL = q.xy - (vec2(-0.24 + uSide * 0.03, 0.1 - uEyeY) + g);
  vec2 eyeR = q.xy - (vec2(0.24 + uSide * 0.03, 0.1 - uEyeY) + g);
  float eyes = (1.0 - smoothstep(-px, px, min(eye(eyeL), eye(eyeR)))) * front;
  vec2 bl = vec2(abs(q.x - uSide * 0.03) - 0.39, q.y - (-0.08 - uEyeY)) / vec2(0.11, 0.06);
  float blush = exp(-dot(bl, bl)) * front * 0.35 * uSat;
  col = mix(col, mix(col, vec3(1.0, 0.45, 0.55), 0.55), blush);
  col = mix(col, vec3(0.08, 0.08, 0.09), eyes);
  if (uMood < 0.5 && uOpen > 0.5) {
    float glint = min(length(eyeL - vec2(0.03, 0.1 * uOpen)), length(eyeR - vec2(0.03, 0.1 * uOpen))) - 0.03;
    col = mix(col, vec3(1.0), (1.0 - smoothstep(-px, px, glint)) * 0.9 * front);
  }
  // The bum: a touch rosy.
  vec3 c = q - vec3(0.0, uSeat, -seatZ + 0.1);
  float bum = smoothstep(0.32, 0.1, min(length(c - vec3(0.165, 0.0, 0.0)), length(c + vec3(0.165, 0.0, 0.0)))) * smoothstep(-0.1, -0.3, q.z);
  col = mix(col, mix(col, vec3(1.0, 0.5, 0.6), 0.18), bum * uSat);

  gl_FragColor = vec4(col * cover, cover + shadow * (1.0 - cover));
}
`;

/** Each shape's bottom (where the bum sits, just above; the hexagon's narrow
 *  point counts as higher so the bum stays on its back) and top, the dome centred between. */
const BOTTOM = [-0.82, -0.66, -0.75, -0.62, -0.88, -0.76, -0.59] as const;
const TOP = [0.82, 0.77, 0.69, 0.66, 0.82, 0.76, 0.53] as const;

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

type Mood = Presence | "paused";

function compile(gl: WebGLRenderingContext): WebGLProgram | null {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type);
    if (s === null) return null;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("[mascot]", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, VERTEX);
  const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
  if (vs === null || fs === null) return null;
  const program = gl.createProgram();
  if (program === null) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

const TURN = Math.PI * 2;

export function Mascot({
  member,
  size = 68,
  turn,
}: {
  member: Member;
  size?: number;
  /** Holds it turned to this angle (radians), for the gallery. */
  turn?: number;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);
  const mood: Mood = member.status === "paused" ? "paused" : member.presence;
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const face = faceOf(member);

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    // A canvas of this run's own: releasing a context on cleanup must never leave
    // the next run (a remount, another member) holding a lost one.
    const element = document.createElement("canvas");
    element.className = "mascot";
    const box = Math.round(size * 1.32);
    element.style.width = `${box}px`;
    element.style.height = `${box}px`;
    parent.appendChild(element);
    const gl = element.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
    const program = gl === null ? null : compile(gl);
    if (gl === null || program === null) {
      element.remove();
      setFailed(true);
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    element.width = Math.round(box * dpr);
    element.height = Math.round(box * dpr);
    gl.viewport(0, 0, element.width, element.height);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(program, "a");
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const u = (name: string) => gl.getUniformLocation(program, name);
    const uniforms = {
      center: u("uCenter"), res: u("uRes"), time: u("uTime"), color: u("uColor"), shape: u("uShape"), eyeY: u("uEyeY"), seat: u("uSeat"),
      offset: u("uOffset"), scale: u("uScale"), lean: u("uLean"), wobble: u("uWobble"), yaw: u("uYaw"),
      jiggle: u("uJiggle"), pitch: u("uPitch"), gaze: u("uGaze"), open: u("uOpen"), mood: u("uMood"), sat: u("uSat"),
      side: u("uSide"),
    };
    gl.uniform2f(uniforms.res, element.width, element.height);
    gl.uniform3f(uniforms.color, ...hexToRgb(face.color));
    gl.uniform1f(uniforms.shape, face.shape);
    gl.uniform1f(uniforms.eyeY, face.eyes / 20);
    const bottom = BOTTOM[face.shape] ?? -0.8;
    gl.uniform1f(uniforms.seat, bottom + 0.3);
    gl.uniform2f(uniforms.center, 0, (bottom + (TOP[face.shape] ?? 0.8)) / 2);
    gl.uniform1f(uniforms.side, member.kind === "hq" ? 0 : 1);

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: 0, y: 0, active: false, at: 0 };
    const onPointer = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      // Eases toward full as the pointer goes further, so it keeps following
      // across the whole window instead of pinning at the edge of a radius.
      const length = Math.hypot(dx, dy);
      const reach = length / (length + 160);
      pointer.x = length === 0 ? 0 : (dx / length) * reach;
      pointer.y = length === 0 ? 0 : (-dy / length) * reach;
      pointer.active = true;
      pointer.at = performance.now();
    };
    window.addEventListener("pointermove", onPointer);

    // Spinning it: a drag turns it, a flick keeps it going, and a moment after
    // you let go it swings back to face you.
    const spin = {
      yaw: turn ?? 0, velocity: 0, pitch: 0, jiggle: 0, jiggleVelocity: 0,
      releasedAt: turn === undefined ? 0 : Number.POSITIVE_INFINITY,
      drag: null as null | { id: number; x: number; y: number; startX: number; startY: number; at: number; moved: boolean },
    };
    const squish = { value: 0, velocity: 0 };
    const onDown = (event: PointerEvent) => {
      element.setPointerCapture(event.pointerId);
      spin.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, at: performance.now(), moved: false };
      resume();
    };
    const onMove = (event: PointerEvent) => {
      const drag = spin.drag;
      if (drag === null || drag.id !== event.pointerId) return;
      const now = performance.now();
      const dx = event.clientX - drag.x;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
      if (!drag.moved) return;
      // Dragging right carries the front to the right.
      const step = -(dx / box) * 3.4;
      spin.yaw += step;
      const dt = Math.max((now - drag.at) / 1000, 1 / 240);
      spin.velocity = spin.velocity * 0.6 + (step / dt) * 0.4;
      spin.pitch = Math.max(-0.35, Math.min(0.45, ((event.clientY - drag.startY) / box) * 0.9));
      drag.x = event.clientX;
      drag.y = event.clientY;
      drag.at = now;
    };
    const onUp = (event: PointerEvent) => {
      const drag = spin.drag;
      if (drag === null || drag.id !== event.pointerId) return;
      spin.drag = null;
      spin.releasedAt = performance.now();
      if (performance.now() - drag.at > 80) spin.velocity = 0;
      if (!drag.moved) squish.velocity += 3.2;
      resume();
    };
    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onUp);

    let gaze = { x: 0, y: 0 };
    let lookWeight = 0;
    let nextBlink = performance.now() + 1500 + Math.random() * 3000;
    let blinkUntil = 0;
    let nextTwirl = performance.now() + 2500 + Math.random() * 3000;
    let visible = true;
    let frame = 0;
    let last = performance.now();
    const start = last;

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const m = moodRef.current;

      // The squish: a damped spring.
      squish.velocity += (-squish.value * 180 - squish.velocity * 12) * dt;
      squish.value += squish.velocity * dt;

      // The spin, and the jelly lag behind it.
      if (spin.drag === null) {
        spin.yaw += spin.velocity * dt;
        spin.velocity *= Math.exp(-dt * 1.8);
        spin.pitch *= Math.exp(-dt * 5);
        if (now - spin.releasedAt > 2200 && Math.abs(spin.velocity) < 1.5) {
          const home = Math.round(spin.yaw / TURN) * TURN;
          spin.velocity += ((home - spin.yaw) * 22 - spin.velocity * 7) * dt;
        }
      }
      const lagTarget = Math.max(-0.5, Math.min(0.5, -spin.velocity * 0.05));
      spin.jiggleVelocity += ((lagTarget - spin.jiggle) * 170 - spin.jiggleVelocity * 7) * dt;
      spin.jiggle += spin.jiggleVelocity * dt;

      let offset = [0, 0];
      let scale = [1, 1];
      let lean = 0;
      let wobble = 0.5;
      let sway = 0;
      let target = pointer.active && now - pointer.at < 8000 ? { x: pointer.x, y: pointer.y } : { x: Math.sin(t * 0.37) * 0.5, y: Math.sin(t * 0.23) * 0.3 };
      let open = 1;
      let moodCode = 0;
      let sat = 1;

      const breathe = Math.sin(t * 1.7) * 0.022;
      scale = [1 + breathe, 1 - breathe];
      if (m === "thinking") {
        target = { x: Math.cos(t * 1.4) * 0.8, y: 0.55 + Math.sin(t * 1.4) * 0.3 };
        sway = Math.sin(t * 0.9) * 0.32;
        wobble = 0.9;
      } else if (m === "working") {
        const phase = Math.abs(Math.sin(t * 4.2));
        offset = [0, phase * 0.11];
        const landing = 1 - Math.min(phase / 0.35, 1);
        scale = [1 + landing * 0.1 - phase * 0.03, 1 - landing * 0.12 + phase * 0.05];
        target = { x: Math.sin(t * 0.9) * 0.4, y: -0.2 };
        wobble = 0.8;
      } else if (m === "waiting") {
        lean = Math.sin(t * 2.3) * 0.13;
        open = 1.08;
        wobble = 0.6;
      } else if (m === "blocked") {
        const burst = Math.max(0, Math.sin(t * 2.6)) ** 6;
        offset = [Math.sin(t * 42) * 0.035 * burst, 0];
        moodCode = -1;
        target = { x: 0, y: -0.35 };
      } else if (m === "done") {
        moodCode = 1;
        offset = [0, Math.abs(Math.sin(t * 2.4)) * 0.04];
        // Now and then, a happy twirl (showing off its bum on the way round).
        if (!still && spin.drag === null && now > nextTwirl && now - spin.releasedAt > 2200) {
          spin.velocity += 13;
          spin.releasedAt = now - 1000;
          nextTwirl = now + 6000 + Math.random() * 4000;
        }
      } else if (m === "paused") {
        moodCode = 2;
        sat = 0.15;
        const slow = Math.sin(t * 0.9) * 0.03;
        scale = [1 + slow, 1 - slow];
        wobble = 0.2;
      }
      scale = [scale[0]! * (1 + squish.value), scale[1]! * (1 - squish.value * 1.2)];

      if (moodCode === 0 && m !== "paused" && now > nextBlink) {
        blinkUntil = now + 130;
        nextBlink = now + 2200 + Math.random() * 4200;
      }
      if (now < blinkUntil) open = 0.05;
      const ease = 1 - Math.exp(-dt * 7);
      gaze = { x: gaze.x + (target.x - gaze.x) * ease, y: gaze.y + (target.y - gaze.y) * ease };
      // Its whole body turns a little toward what it looks at, except mid-spin or asleep.
      const looking = spin.drag === null && Math.abs(spin.velocity) < 0.6 && m !== "paused" ? 1 : 0;
      lookWeight += (looking - lookWeight) * (1 - Math.exp(-dt * 4));

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uniforms.time, t);
      gl.uniform2f(uniforms.offset, offset[0]!, offset[1]!);
      gl.uniform2f(uniforms.scale, scale[0]!, scale[1]!);
      gl.uniform1f(uniforms.lean, lean);
      gl.uniform1f(uniforms.wobble, still ? 0 : wobble);
      gl.uniform1f(uniforms.yaw, spin.yaw + (still ? 0 : sway - gaze.x * 0.42 * lookWeight));
      gl.uniform1f(uniforms.jiggle, still ? 0 : spin.jiggle);
      gl.uniform1f(uniforms.pitch, 0.14 + spin.pitch - (still ? 0 : gaze.y * 0.24 * lookWeight));
      gl.uniform2f(uniforms.gaze, gaze.x, gaze.y);
      gl.uniform1f(uniforms.open, open);
      gl.uniform1f(uniforms.mood, moodCode);
      gl.uniform1f(uniforms.sat, sat);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      const turning = spin.drag !== null || Math.abs(spin.velocity) > 0.01 || Math.abs(spin.yaw - Math.round(spin.yaw / TURN) * TURN) > 0.002 || Math.abs(squish.velocity) > 0.01;
      if ((!still || turning) && visible && !document.hidden) frame = requestAnimationFrame(draw);
    };

    function resume() {
      cancelAnimationFrame(frame);
      last = performance.now();
      frame = requestAnimationFrame(draw);
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) resume();
    });
    observer.observe(element);
    const onVisibility = () => {
      if (!document.hidden) resume();
    };
    document.addEventListener("visibilitychange", onVisibility);
    resume();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      element.remove();
    };
    // The face is fixed for a member; the mood is read live from a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.id, size, turn]);

  if (failed) return <Avatar member={member} size={size} />;
  const box = Math.round(size * 1.32);
  return (
    <span
      ref={host}
      className="mascot-host"
      style={{ width: box, height: box, margin: -(box - size) / 2 }}
      title="Drag to spin"
      aria-hidden="true"
    />
  );
}
