#include <napi.h>
#include <string>
#include "cmg_native.h"

Napi::Value DecryptSegment(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Buffer expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Buffer<uint8_t> inBuf = info[0].As<Napi::Buffer<uint8_t>>();
    Napi::Buffer<uint8_t> outBuf = Napi::Buffer<uint8_t>::Copy(env, inBuf.Data(), inBuf.Length());

    int perNalUpdate = 1;
    int sanitizeSps = 1;
    if (info.Length() >= 2 && info[1].IsBoolean()) {
        perNalUpdate = info[1].As<Napi::Boolean>().Value() ? 1 : 0;
    }
    if (info.Length() >= 3 && info[2].IsBoolean()) {
        sanitizeSps = info[2].As<Napi::Boolean>().Value() ? 1 : 0;
    }

    int slices = cmg_native_decrypt_ts(outBuf.Data(), outBuf.Length(), perNalUpdate, sanitizeSps);
    outBuf.Set(Napi::String::New(env, "sliceCount"), Napi::Number::New(env, slices));
    return outBuf;
}

Napi::Value InitPlayer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string href = "https://www.yangshipin.cn/tv/home";
    std::string tag = "1791208727000";
    if (info.Length() >= 1 && info[0].IsString()) {
        href = info[0].As<Napi::String>().Utf8Value();
    }
    if (info.Length() >= 2 && info[1].IsString()) {
        tag = info[1].As<Napi::String>().Utf8Value();
    }
    int res = cmg_native_init(href.c_str(), tag.c_str());
    return Napi::Number::New(env, res);
}

Napi::Value UpdatePlayer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int tag = cmg_native_update();
    return Napi::Number::New(env, (uint32_t)tag);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "decryptSegment"), Napi::Function::New(env, DecryptSegment));
    exports.Set(Napi::String::New(env, "initPlayer"), Napi::Function::New(env, InitPlayer));
    exports.Set(Napi::String::New(env, "updatePlayer"), Napi::Function::New(env, UpdatePlayer));
    return exports;
}

NODE_API_MODULE(cmg_decrypt, Init)
