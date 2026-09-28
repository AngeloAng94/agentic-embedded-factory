# EmbedFactory reference Zephyr application.
#
# This is the stock Zephyr application boilerplate: `west build` exports
# ZEPHYR_BASE for the cmake process it spawns, so find_package(Zephyr) resolves
# the Zephyr build system without any extra configuration.
cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(embedfactory_reference)

target_sources(app PRIVATE src/main.c)
