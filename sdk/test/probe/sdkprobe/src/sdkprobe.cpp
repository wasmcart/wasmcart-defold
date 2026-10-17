// sdkprobe: the smallest native extension that proves the SDK relink. A Lua
// module with one function that does arithmetic in C++ and one that reports
// whether the extension was compiled for a wasmcart cart.
#define EXTENSION_NAME SdkProbe
#define LIB_NAME "SdkProbe"
#define MODULE_NAME "sdkprobe"

#include <dmsdk/sdk.h>

static int Add(lua_State* L)
{
    lua_Number a = luaL_checknumber(L, 1);
    lua_Number b = luaL_checknumber(L, 2);
    lua_pushnumber(L, a + b);
    return 1;
}

static int Platform(lua_State* L)
{
#if defined(DM_PLATFORM_WASMCART)
    lua_pushstring(L, "wasmcart");
#else
    lua_pushstring(L, "other");
#endif
    return 1;
}

static const luaL_reg Module_methods[] =
{
    {"add", Add},
    {"platform", Platform},
    {0, 0}
};

static dmExtension::Result AppInitialize(dmExtension::AppParams* params) { return dmExtension::RESULT_OK; }
static dmExtension::Result AppFinalize(dmExtension::AppParams* params) { return dmExtension::RESULT_OK; }

static dmExtension::Result Initialize(dmExtension::Params* params)
{
    luaL_register(params->m_L, MODULE_NAME, Module_methods);
    lua_pop(params->m_L, 1);
    return dmExtension::RESULT_OK;
}

static dmExtension::Result Finalize(dmExtension::Params* params) { return dmExtension::RESULT_OK; }

DM_DECLARE_EXTENSION(EXTENSION_NAME, LIB_NAME, AppInitialize, AppFinalize, Initialize, 0, 0, Finalize)
