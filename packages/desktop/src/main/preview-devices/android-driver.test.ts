import assert from "node:assert/strict";
import test from "node:test";
import { androidSdkCandidates, detectAndroidSdk, androidAbi, androidSystemImage } from "./android-sdk.ts";
import { androidBuildArguments, androidEmulatorArguments, androidUiNodes } from "./android-parsers.ts";
import { androidDiscovery, AndroidGrpc, androidGrpcDefinition } from "./android-grpc.ts";
import { parseBuildErrors } from "./build-errors.ts";
import * as grpc from "@grpc/grpc-js";

test("SDK detection respects explicit paths and platform defaults", () => {
  assert.ok(androidSdkCandidates("darwin","/Users/me","/data",{}).includes("/Users/me/Library/Android/sdk"));
  assert.ok(androidSdkCandidates("linux","/home/me","/data",{}).includes("/home/me/Android/Sdk"));
  assert.ok(androidSdkCandidates("win32","C:\\Users\\me","C:\\data",{LOCALAPPDATA:"C:\\Users\\me\\AppData\\Local"}).includes("C:\\Users\\me\\AppData\\Local\\Android\\Sdk"));
  assert.equal(detectAndroidSdk("linux","/home/me","/data",{ANDROID_HOME:"/custom"},(p)=>String(p)==="/custom/cmdline-tools/latest/bin/sdkmanager"),"/custom");
  assert.equal(androidAbi("darwin","arm64"),"arm64-v8a");
  assert.equal(androidSystemImage("35","x86_64"),"system-images;android-35;google_apis;x86_64");
  assert.throws(()=>androidSystemImage("35;other"));
});
test("Gradle and emulator commands are bounded, headless and read-only", () => {
  assert.deepEqual(androidBuildArguments({ build: { module: "app",variant:"demoDebug" } } as never),[":app:assembleDemoDebug"]);
  assert.throws(()=>androidBuildArguments({build:{module:"app; rm anything"}} as never));
  const args=androidEmulatorArguments("Blame_Phone",5554,8554);
  assert.ok(args.includes("-read-only"));assert.ok(args.includes("-no-window"));assert.ok(args.includes("-grpc-use-token"));
  assert.throws(()=>androidEmulatorArguments("Blame_Phone",5555,8554));
  const errors=parseBuildErrors("e: file:///mirror/Main.kt:12:4 Unresolved reference\n/mirror/Main.java:14: error: cannot find symbol","/mirror","/worktree");
  assert.equal(errors.length,2);assert.equal(errors[0]!.file,"/worktree/Main.kt");assert.equal(errors[1]!.line,14);
});
test("uiautomator bounds become device-independent points and trees are bounded", () => {
  const xml='<hierarchy><node class="android.widget.Button" text="Save &amp; close" content-desc="Save" bounds="[30,60][330,210]" /></hierarchy>';
  assert.deepEqual(androidUiNodes(xml,480),[{role:"android.widget.Button",label:"Save",value:"Save & close",frame:{x:10,y:20,width:100,height:50}}]);
  assert.equal(androidUiNodes(xml.repeat(500),480).length,400);
});
test("generated gRPC client authenticates frames and releases touch contact", async () => {
  const service=androidGrpcDefinition["android.emulation.control.EmulatorController"] as grpc.ServiceDefinition;
  const server=new grpc.Server(),touches:unknown[]=[];
  const png=Buffer.from([137,80,78,71,13,10,26,10]);
  const image={image:png,format:{format:"PNG",width:1080,height:2400}};
  const authorize=(call:grpc.ServerUnaryCall<unknown,unknown>|grpc.ServerWritableStream<unknown,unknown>)=>assert.equal(call.metadata.get("authorization")[0],"Bearer test-token");
  server.addService(service,{
    getScreenshot(call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>){authorize(call);callback(null,image);},
    streamScreenshot(call:grpc.ServerWritableStream<unknown,unknown>){authorize(call);call.write(image);call.end();},
    sendTouch(call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>){authorize(call);touches.push(call.request);callback(null,{});},
    sendKey(call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>){authorize(call);callback(null,{});},
  });
  const port=await new Promise<number>((resolve,reject)=>server.bindAsync("127.0.0.1:0",grpc.ServerCredentials.createInsecure(),(e,p)=>e?reject(e):resolve(p)));
  const discovery=androidDiscovery(`grpc.port=${port}\ngrpc.token=test-token\n`,port)!;
  assert.equal(androidDiscovery(`grpc.port=${port+1}\ngrpc.token=test-token`,port),undefined);
  const client=new AndroidGrpc(discovery.port,discovery.token);
  try {
    assert.deepEqual((await client.screenshot()).image,png);
    await client.tap(30,60);assert.equal(touches.length,2);
    assert.equal((touches[1] as {touches:Array<{pressure:number}>}).touches[0]!.pressure,0);
    const frames=[];for await(const frame of client.frames(new AbortController().signal))frames.push(frame);
    assert.equal(frames.length,1);assert.deepEqual(frames[0]!.image,png);
  } finally {client.close();server.forceShutdown();}
});
