# CMakeLists.txt — lib nativa picmaxenhance (Task 10): Real-ESRGAN via NCNN (Vulkan/CPU).
# O prebuilt do NCNN (ncnn-20240820-android-vulkan/, só arm64-v8a + x86_64 — os 2 ABIs do
# abiFilters em android/app/build.gradle) está vendorado no repo; os zips de release não.
cmake_minimum_required(VERSION 3.22)
project(picmaxenhance CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(ncnn_DIR ${CMAKE_CURRENT_SOURCE_DIR}/ncnn-20240820-android-vulkan/${ANDROID_ABI}/lib/cmake/ncnn)
if(NOT EXISTS ${ncnn_DIR}/ncnnConfig.cmake)
    message(FATAL_ERROR
        "Prebuilt do NCNN não encontrado para ABI ${ANDROID_ABI} em ${ncnn_DIR}. "
        "Baixe https://github.com/Tencent/ncnn/releases/download/20240820/ncnn-20240820-android-vulkan.zip "
        "e extraia em android/app/src/main/cpp/ (o repo vendora só arm64-v8a e x86_64).")
endif()
find_package(ncnn REQUIRED)

add_library(picmaxenhance SHARED jni.cpp realesrgan.cpp)
target_link_libraries(picmaxenhance ncnn android jnigraphics log)
