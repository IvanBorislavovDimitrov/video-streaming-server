import express, { Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";

const HTTP_PORT: number = 3000;
const VIDEO_FILE: string = "out/recorded_video.mp4";

// Configurable video parameters
const VIDEO_WIDTH: number = 640;   // Default width - adjust as needed
const VIDEO_HEIGHT: number = 480;  // Default height - adjust as needed
const FRAME_RATE: number = 30;     // Default frame rate

const app = express();
const server = app.listen(HTTP_PORT, () => {
    console.log(`Server listening on http://localhost:${HTTP_PORT}`);
});

// Serve HTML page for live stream playback
app.get("/", (_: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// Serve recorded video file for download
app.use(express.static("."));

const wss = new WebSocketServer({ server });

let ffmpeg: ChildProcessWithoutNullStreams | null = null;
let recording: boolean = false;
let frameCount: number = 0;

// Start recording function
const startRecording = (): void => {
    if (recording) return;
    console.log("Starting recording...");
    frameCount = 0;

    try {
        ffmpeg = spawn("ffmpeg", [
            "-f", "image2pipe",   // Input from a series of image files/pipes
            "-vcodec", "mjpeg",   // MJPEG input codec
            "-s", `${VIDEO_WIDTH}x${VIDEO_HEIGHT}`, // Specify image dimensions
            "-r", `${FRAME_RATE}`, // Frame rate
            "-i", "-",            // Input from stdin
            "-c:v", "libx264",    // Output codec H.264
            "-preset", "ultrafast",
            "-pix_fmt", "yuv420p", // Pixel format for compatibility
            "-y", VIDEO_FILE       // Output file
        ]);

        ffmpeg.stderr.on("data", (data: Buffer) => {
            const message = data.toString().trim();
            if (message) {
                console.log(`FFmpeg log: ${message}`);
            }
        });

        ffmpeg.on("exit", (code) => {
            console.log(`FFmpeg process exited with code ${code || 0}.`);
            recording = false;
            console.log(`Recorded ${frameCount} frames to ${VIDEO_FILE}`);
        });

        ffmpeg.on("error", (err) => {
            console.error("FFmpeg process error:", err);
            recording = false;
        });

        recording = true;
    } catch (error) {
        console.error("Error starting FFmpeg:", error);
    }
};

// Stop recording function
const stopRecording = (): void => {
    if (!recording || !ffmpeg) return;
    console.log("Stopping recording...");

    try {
        ffmpeg.stdin.end();
        ffmpeg.kill();
        console.log(`Ending recording after ${frameCount} frames`);
    } catch (error) {
        console.error("Error stopping recording:", error);
    }
    
    recording = false;
};

// WebSocket connection for video streaming
wss.on("connection", (ws: WebSocket) => {
    console.log("Client connected");

    ws.on("message", (data: Buffer | string) => {
        if (typeof data === "string") {
            console.log("Received text message:", data);
            return;
        }

        // Log first few frames for debugging
        if (frameCount < 5) {
            console.log(`Frame ${frameCount} size: ${data.length} bytes`);
        }

        // 1. Broadcast frames to all connected clients
        wss.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });

        // 2. If recording, send frame to FFmpeg
        if (recording && ffmpeg && ffmpeg.stdin.writable) {
            try {
                ffmpeg.stdin.write(data);
                frameCount++;
                
                // Log occasionally to show progress
                if (frameCount % 300 === 0) { // Log every ~10 seconds at 30fps
                    console.log(`Recorded ${frameCount} frames so far`);
                }
            } catch (error) {
                console.error("Error writing to FFmpeg:", error);
            }
        }
    });

    ws.on("close", () => {
        console.log("Client disconnected");
    });
});

// API endpoints to control recording
app.get("/start-recording", (_: Request, res: Response) => {
    startRecording();
    res.json({ status: "Recording started", recording: true });
});

app.get("/stop-recording", (_: Request, res: Response) => {
    stopRecording();
    res.json({ 
        status: "Recording stopped", 
        recording: false, 
        frames: frameCount,
        videoFile: VIDEO_FILE
    });
});

// Add endpoint to check recording status
app.get("/recording-status", (_: Request, res: Response) => {
    res.json({ 
        recording, 
        frames: frameCount,
        videoFile: recording ? null : VIDEO_FILE 
    });
});

process.on("SIGINT", () => {
    stopRecording();
    process.exit();
});