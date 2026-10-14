"use client";

import { useEffect, useRef, useState } from "react";

import { Avatar, faceOf } from "./avatar";
import type { Member, Presence } from "./types";

/**
 * A member's face, alive: a small WebGL shader that draws the same shape and
 * colour as its SVG avatar as a soft, lit jelly with eyes, and moves by mood.
 *
 * - Idle: breathes, glances at your pointer, blinks now and then.
 * - Thinking: a slow swirl, eyes circling up and away.
 * - Working: hops, squashing on landing and stretching on the way up.
 * - Waiting (needs you): sways, eyes wide and on you.
 * - Blocked: an uneasy shudder every few seconds, eyes narrowed.
 * - Done: happy arc eyes and a little bounce.
 * - Paused: eyes shut, slow breathing, colour drained.
 *
 * A click gives it a springy squish. One canvas, drawn only while it is on
 * screen and the page is visible; with reduced motion it holds still; where
 * WebGL is missing it is the SVG avatar.
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
uniform vec2 uOffset;
uniform vec2 uScale;
uniform float uLean;
uniform float uWobble;
uniform float uTwist;
uniform vec2 uGaze;
uniform float uOpen;
uniform float uMood;
uniform float uSat;
uniform float uSide;

const float FRAME = 1.32;

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

float body(vec2 p) {
  if (uShape < 0.5) return length(p) - 0.82;
  if (uShape < 1.5) return sdHexagon(p.yx, 0.6) - 0.08;
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

/** How high the jelly stands at p: a rounded dome, steep at the rim, flat on top. */
float bump(vec2 p) { float x = 1.0 - clamp(-body(p) / 0.75, 0.0, 1.0); return 1.0 - x * x; }
/** Averaged over a small neighbourhood, so the ridges a distance field has inside corners melt away. */
float dome(vec2 p) {
  const float r = 0.07;
  return (bump(p) * 2.0 + bump(p + vec2(r, r)) + bump(p + vec2(r, -r)) + bump(p + vec2(-r, r)) + bump(p + vec2(-r, -r))) / 6.0;
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

/** The body's own space: hop, lean, squash about the base, a jelly wobble, a swirl. */
vec2 local(vec2 p0) {
  vec2 p = p0 - uOffset;
  p = rot(uLean) * (p + vec2(0.0, 0.8)) - vec2(0.0, 0.8);
  p.x /= uScale.x;
  p.y = (p.y + 0.82) / uScale.y - 0.82;
  p += uWobble * 0.022 * vec2(sin(p.y * 5.0 + uTime * 3.1), sin(p.x * 4.2 + uTime * 2.4));
  p = rot(uTwist * 0.5 * smoothstep(1.1, 0.0, length(p))) * p;
  return p;
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

  // A soft contact shadow, smaller and fainter as it leaves the ground.
  float lift = clamp(uOffset.y * 6.0, 0.0, 1.0);
  vec2 sq = (p0 - vec2(uOffset.x, -0.93)) / vec2(0.62 * (1.0 - 0.35 * lift) * uScale.x, 0.075);
  float shadow = exp(-dot(sq, sq) * 1.6) * (0.2 - 0.12 * lift);

  vec2 p = local(p0);
  float d = body(p);
  float alpha = 1.0 - smoothstep(-px, px, d);
  if (alpha <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, shadow); return; }

  // Light a smooth dome over the shape rather than the shape's edge distance,
  // whose kinks inside faceted shapes would show as creases.
  vec2 e = vec2(0.045, 0.0);
  float hx = dome(p + e.xy) - dome(p - e.xy);
  float hy = dome(p + e.yx) - dome(p - e.yx);
  vec3 n = normalize(vec3(-hx, -hy, 2.0 * e.x * 0.9));
  vec3 light = normalize(vec3(-0.45, 0.7, 0.8));
  float diff = max(dot(n, light), 0.0);
  float spec = pow(max(dot(reflect(-light, n), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
  float rim = pow(1.0 - n.z, 2.5);

  vec3 base = mix(vec3(dot(uColor, vec3(0.299, 0.587, 0.114))), uColor, uSat);
  vec3 col = base * (0.52 + 0.62 * diff);
  col += vec3(1.0) * spec * 0.55;
  col += mix(base, vec3(1.0), 0.6) * rim * 0.28;
  col = mix(col * 0.86, col, smoothstep(-0.9, 0.6, p.y));

  // Eyes, in the body's space so they squash with it, looking where it looks.
  vec2 g = uGaze * vec2(0.075, 0.06);
  vec2 left = p - (vec2(-0.24 + uSide * 0.03, 0.1 - uEyeY) + g);
  vec2 right = p - (vec2(0.24 + uSide * 0.03, 0.1 - uEyeY) + g);
  float de = min(eye(left), eye(right));
  float eyeMask = 1.0 - smoothstep(-px, px, de);
  vec3 ink = vec3(0.08, 0.08, 0.09);
  col = mix(col, ink, eyeMask);
  if (uMood < 0.5 && uOpen > 0.5) {
    float glint = min(length(left - vec2(0.03, 0.1 * uOpen)), length(right - vec2(0.03, 0.1 * uOpen))) - 0.03;
    col = mix(col, vec3(1.0), (1.0 - smoothstep(-px, px, glint)) * 0.9);
  }

  float a = alpha + shadow * (1.0 - alpha);
  vec3 outc = col * alpha;
  gl_FragColor = vec4(outc, a);
}
`;

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

export function Mascot({ member, size = 68 }: { member: Member; size?: number }) {
  const host = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);
  const mood: Mood = member.status === "paused" ? "paused" : member.presence;
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const boop = useRef({ value: 0, velocity: 0 });
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
    const gl = element.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: true });
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
      res: u("uRes"), time: u("uTime"), color: u("uColor"), shape: u("uShape"), eyeY: u("uEyeY"), offset: u("uOffset"),
      scale: u("uScale"), lean: u("uLean"), wobble: u("uWobble"), twist: u("uTwist"), gaze: u("uGaze"), open: u("uOpen"),
      mood: u("uMood"), sat: u("uSat"), side: u("uSide"),
    };
    gl.uniform2f(uniforms.res, element.width, element.height);
    gl.uniform3f(uniforms.color, ...hexToRgb(face.color));
    gl.uniform1f(uniforms.shape, face.shape);
    gl.uniform1f(uniforms.eyeY, face.eyes / 20);
    gl.uniform1f(uniforms.side, member.kind === "hq" ? 0 : 1);

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: 0, y: 0, active: false, at: 0 };
    const onPointer = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      const dx = (event.clientX - (rect.left + rect.width / 2)) / 260;
      const dy = (event.clientY - (rect.top + rect.height / 2)) / 260;
      const length = Math.hypot(dx, dy);
      const scale = length > 1 ? 1 / length : 1;
      pointer.x = dx * scale;
      pointer.y = -dy * scale;
      pointer.active = true;
      pointer.at = performance.now();
    };
    window.addEventListener("pointermove", onPointer);

    let gaze = { x: 0, y: 0 };
    let nextBlink = performance.now() + 1500 + Math.random() * 3000;
    let blinkUntil = 0;
    let visible = true;
    let frame = 0;
    let last = performance.now();
    const start = last;

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const m = moodRef.current;

      // The boop: a damped spring on squash.
      const spring = boop.current;
      spring.velocity += (-spring.value * 180 - spring.velocity * 12) * dt;
      spring.value += spring.velocity * dt;

      let offset = [0, 0];
      let scale = [1, 1];
      let lean = 0;
      let wobble = 0.5;
      let twist = 0;
      let target = pointer.active && now - pointer.at < 4000 ? { x: pointer.x, y: pointer.y } : { x: Math.sin(t * 0.37) * 0.5, y: Math.sin(t * 0.23) * 0.3 };
      let open = 1;
      let moodCode = 0;
      let sat = 1;

      const breathe = Math.sin(t * 1.7) * 0.022;
      scale = [1 + breathe, 1 - breathe];
      if (m === "thinking") {
        target = { x: Math.cos(t * 1.4) * 0.8, y: 0.55 + Math.sin(t * 1.4) * 0.3 };
        twist = Math.sin(t * 1.8) * 0.5;
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
      } else if (m === "paused") {
        moodCode = 2;
        sat = 0.15;
        const slow = Math.sin(t * 0.9) * 0.03;
        scale = [1 + slow, 1 - slow];
        wobble = 0.2;
      }
      scale = [scale[0]! * (1 + spring.value), scale[1]! * (1 - spring.value * 1.2)];

      if (moodCode === 0 && m !== "paused" && now > nextBlink) {
        blinkUntil = now + 130;
        nextBlink = now + 2200 + Math.random() * 4200;
      }
      if (now < blinkUntil) open = 0.05;
      const ease = 1 - Math.exp(-dt * 7);
      gaze = { x: gaze.x + (target.x - gaze.x) * ease, y: gaze.y + (target.y - gaze.y) * ease };

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uniforms.time, t);
      gl.uniform2f(uniforms.offset, offset[0]!, offset[1]!);
      gl.uniform2f(uniforms.scale, scale[0]!, scale[1]!);
      gl.uniform1f(uniforms.lean, lean);
      gl.uniform1f(uniforms.wobble, still ? 0 : wobble);
      gl.uniform1f(uniforms.twist, still ? 0 : twist);
      gl.uniform2f(uniforms.gaze, gaze.x, gaze.y);
      gl.uniform1f(uniforms.open, open);
      gl.uniform1f(uniforms.mood, moodCode);
      gl.uniform1f(uniforms.sat, sat);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (!still && visible && !document.hidden) frame = requestAnimationFrame(draw);
    };

    const resume = () => {
      cancelAnimationFrame(frame);
      last = performance.now();
      frame = requestAnimationFrame(draw);
    };
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
  }, [member.id, size]);

  if (failed) return <Avatar member={member} size={size} />;
  const box = Math.round(size * 1.32);
  return (
    <span
      ref={host}
      className="mascot-host"
      style={{ width: box, height: box, margin: -(box - size) / 2 }}
      aria-hidden="true"
      onPointerDown={() => {
        boop.current.velocity += 3.2;
      }}
    />
  );
}
