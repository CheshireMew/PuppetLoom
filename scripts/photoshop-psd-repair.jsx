#target photoshop

(function () {
    function fail(message) { throw new Error("PuppetLoom PSD repair: " + message); }

    function readText(path) {
        var file = new File(path);
        if (!file.exists) fail("repair recipe not found: " + path);
        file.encoding = "UTF8";
        if (!file.open("r")) fail("cannot open repair recipe: " + path);
        var text = file.read();
        file.close();
        return text;
    }

    function readRecipe(path) {
        var recipe;
        try { recipe = eval("(" + readText(path) + ")"); }
        catch (error) { fail("cannot parse repair recipe: " + error.message); }
        if (!recipe || recipe.version !== 1 || recipe.kind !== "puppetloom-photoshop-psd-repair") fail("invalid repair recipe version or kind." );
        return recipe;
    }

    function jsonQuote(value) {
        return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
    }

    function jsonStringify(value) {
        if (value === null) return "null";
        if (value === true) return "true";
        if (value === false) return "false";
        if (typeof value === "number") return isFinite(value) ? String(value) : "null";
        if (typeof value === "string") return jsonQuote(value);
        if (value instanceof Array) {
            var arrayParts = [];
            for (var arrayIndex = 0; arrayIndex < value.length; arrayIndex += 1) arrayParts.push(jsonStringify(value[arrayIndex]));
            return "[" + arrayParts.join(",") + "]";
        }
        var objectParts = [];
        for (var key in value) if (value.hasOwnProperty(key) && typeof value[key] !== "undefined") objectParts.push(jsonQuote(key) + ":" + jsonStringify(value[key]));
        return "{" + objectParts.join(",") + "}";
    }

    function selectorLabel(selector) {
        return selector instanceof Array ? selector.join("/") : String(selector);
    }

    function namedChildren(container, name) {
        var matches = [];
        for (var index = 0; index < container.layers.length; index += 1) {
            var layer = container.layers[index];
            if (layer.name === name) matches.push(layer);
        }
        return matches;
    }

    function collectNamed(container, name, output) {
        for (var index = 0; index < container.layers.length; index += 1) {
            var layer = container.layers[index];
            if (layer.name === name) output.push(layer);
            if (layer.typename === "LayerSet") collectNamed(layer, name, output);
        }
    }

    function findLayer(document, selector) {
        if (selector instanceof Array) {
            var container = document;
            for (var index = 0; index < selector.length; index += 1) {
                var matches = namedChildren(container, selector[index]);
                if (matches.length !== 1) fail("layer path is missing or ambiguous: " + selectorLabel(selector));
                container = matches[0];
            }
            return container;
        }
        var all = [];
        collectNamed(document, String(selector), all);
        if (all.length !== 1) fail("layer name is missing or ambiguous: " + selectorLabel(selector));
        return all[0];
    }

    function sourceEntry(recipe, id) {
        for (var index = 0; index < recipe.sources.length; index += 1) if (recipe.sources[index].id === id) return recipe.sources[index];
        fail("source id not found: " + id);
    }

    function openDocument(path, opened) {
        var file = new File(path);
        if (!file.exists) fail("input file not found: " + path);
        var document = app.open(file);
        opened.push(document);
        return document;
    }

    function unit(value) { return value && value.as ? value.as("px") : Number(value); }

    function normalizeSourceCanvas(source, target, policy, label) {
        var sourceWidth = unit(source.width);
        var sourceHeight = unit(source.height);
        var targetWidth = unit(target.width);
        var targetHeight = unit(target.height);
        var matches = Math.round(sourceWidth) === Math.round(targetWidth) && Math.round(sourceHeight) === Math.round(targetHeight);
        var selectedPolicy = policy || "require-match";
        var transform = {
            policy: selectedPolicy,
            source: { width: sourceWidth, height: sourceHeight },
            target: { width: targetWidth, height: targetHeight },
            applied: false,
            scaleX: targetWidth / sourceWidth,
            scaleY: targetHeight / sourceHeight
        };
        if (matches) return transform;
        if (selectedPolicy !== "fit-full-canvas") fail(label + " canvas does not match the canonical canvas; set canvasPolicy to fit-full-canvas only for a full-canvas donor with the same aspect ratio." );
        var cross = Math.abs(sourceWidth * targetHeight - targetWidth * sourceHeight);
        var denominator = Math.max(1, sourceWidth * targetHeight, targetWidth * sourceHeight);
        if (cross / denominator > 0.001) fail(label + " aspect ratio does not match the canonical canvas; refusing to stretch or guess placement." );
        app.activeDocument = source;
        source.resizeImage(new UnitValue(targetWidth, "px"), new UnitValue(targetHeight, "px"), target.resolution, ResampleMethod.BICUBIC);
        transform.applied = true;
        return transform;
    }

    function selectRectangle(document, bounds) {
        document.selection.select([
            [bounds[0], bounds[1]],
            [bounds[2], bounds[1]],
            [bounds[2], bounds[3]],
            [bounds[0], bounds[3]]
        ], SelectionType.REPLACE, 0, false);
    }

    function clearRegion(document, layer, bounds) {
        app.activeDocument = document;
        document.activeLayer = layer;
        selectRectangle(document, bounds);
        document.selection.clear();
        document.selection.deselect();
    }

    function placeLayer(document, layer, placement) {
        if (!placement) return;
        var reference = findLayer(document, placement.relativeTo);
        layer.move(reference, placement.position === "before" ? ElementPlacement.PLACEBEFORE : ElementPlacement.PLACEAFTER);
    }

    function removeWhiteMatte(document, layer) {
        app.activeDocument = document;
        document.activeLayer = layer;
        executeAction(charIDToTypeID("RmvW"), undefined, DialogModes.NO);
    }

    function defringe(document, layer, pixels) {
        app.activeDocument = document;
        document.activeLayer = layer;
        var descriptor = new ActionDescriptor();
        descriptor.putInteger(charIDToTypeID("Wdth"), pixels);
        executeAction(charIDToTypeID("Dfrg"), descriptor, DialogModes.NO);
    }

    function selectBackgroundMagicWand(document, tolerance) {
        app.activeDocument = document;
        var descriptor = new ActionDescriptor();
        var selectionReference = new ActionReference();
        selectionReference.putProperty(charIDToTypeID("Chnl"), charIDToTypeID("fsel"));
        descriptor.putReference(charIDToTypeID("null"), selectionReference);
        var point = new ActionDescriptor();
        point.putDouble(charIDToTypeID("Hrzn"), 2);
        point.putDouble(charIDToTypeID("Vrtc"), 2);
        descriptor.putObject(charIDToTypeID("T   "), charIDToTypeID("Pnt "), point);
        descriptor.putInteger(charIDToTypeID("Tlrn"), tolerance);
        descriptor.putBoolean(charIDToTypeID("AntA"), true);
        descriptor.putBoolean(charIDToTypeID("Cntg"), true);
        descriptor.putBoolean(charIDToTypeID("Mrgd"), false);
        executeAction(charIDToTypeID("setd"), descriptor, DialogModes.NO);
    }

    function selectSubject(document) {
        app.activeDocument = document;
        var descriptor = new ActionDescriptor();
        descriptor.putBoolean(stringIDToTypeID("sampleAllLayers"), false);
        executeAction(stringIDToTypeID("autoCutout"), descriptor, DialogModes.NO);
    }

    function extractWhiteRegion(target, operation, opened) {
        var source = openDocument(operation.sourceImage, opened);
        app.activeDocument = source;
        var canvasTransform = normalizeSourceCanvas(source, target, operation.canvasPolicy, operation.name);
        source.crop(operation.bounds);
        if (operation.method === "select-subject") selectSubject(source);
        else {
            selectBackgroundMagicWand(source, operation.tolerance);
            source.selection.invert();
        }
        var selectedBounds;
        try { selectedBounds = source.selection.bounds; }
        catch (error) { fail("extracted region has no foreground: " + operation.name); }
        var expectedLeft = operation.bounds[0] + unit(selectedBounds[0]);
        var expectedTop = operation.bounds[1] + unit(selectedBounds[1]);
        source.activeLayer = source.layers[0];
        source.selection.copy(false);
        app.activeDocument = target;
        var pasted = target.paste();
        pasted.name = operation.name;
        var pastedBounds = pasted.bounds;
        pasted.translate(expectedLeft - unit(pastedBounds[0]), expectedTop - unit(pastedBounds[1]));
        removeWhiteMatte(target, pasted);
        placeLayer(target, pasted, operation.placement);
        source.close(SaveOptions.DONOTSAVECHANGES);
        opened.pop();
        return { canvasTransform: canvasTransform };
    }

    function mergeLayers(document, selectors, name, placement) {
        var layers = [];
        for (var index = 0; index < selectors.length; index += 1) layers.push(findLayer(document, selectors[index]));
        var merged = layers[layers.length - 1];
        for (var mergeIndex = layers.length - 2; mergeIndex >= 0; mergeIndex -= 1) {
            var upper = layers[mergeIndex];
            upper.move(merged, ElementPlacement.PLACEBEFORE);
            document.activeLayer = upper;
            merged = upper.merge();
        }
        merged.name = name;
        placeLayer(document, merged, placement);
        return merged;
    }

    function perform(document, recipe, operation, opened) {
        app.activeDocument = document;
        if (operation.op === "delete-layer") {
            findLayer(document, operation.layer).remove();
        } else if (operation.op === "rename-layer") {
            findLayer(document, operation.layer).name = operation.name;
        } else if (operation.op === "set-visibility") {
            findLayer(document, operation.layer).visible = operation.visible;
        } else if (operation.op === "move-layer") {
            placeLayer(document, findLayer(document, operation.layer), operation.placement);
        } else if (operation.op === "duplicate-layer") {
            var sourceConfiguration = sourceEntry(recipe, operation.source);
            var source = openDocument(sourceConfiguration.path, opened);
            var canvasTransform = normalizeSourceCanvas(source, document, sourceConfiguration.canvasPolicy, operation.source);
            var sourceLayer = findLayer(source, operation.layer);
            var duplicate = sourceLayer.duplicate(document, ElementPlacement.PLACEATBEGINNING);
            app.activeDocument = document;
            duplicate.name = operation.name;
            app.activeDocument = source;
            source.close(SaveOptions.DONOTSAVECHANGES);
            opened.pop();
            app.activeDocument = document;
            placeLayer(document, duplicate, operation.placement);
            return { canvasTransform: canvasTransform };
        } else if (operation.op === "split-layer-x") {
            var original = findLayer(document, operation.layer);
            var right = original.duplicate();
            original.name = operation.leftName;
            right.name = operation.rightName;
            clearRegion(document, original, [operation.splitX, 0, document.width.as("px"), document.height.as("px")]);
            clearRegion(document, right, [0, 0, operation.splitX, document.height.as("px")]);
        } else if (operation.op === "clear-region") {
            clearRegion(document, findLayer(document, operation.layer), operation.bounds);
        } else if (operation.op === "extract-white-region") {
            return extractWhiteRegion(document, operation, opened);
        } else if (operation.op === "remove-white-matte") {
            removeWhiteMatte(document, findLayer(document, operation.layer));
        } else if (operation.op === "defringe") {
            defringe(document, findLayer(document, operation.layer), operation.pixels);
        } else if (operation.op === "merge-layers") {
            mergeLayers(document, operation.layers, operation.name, operation.placement);
        } else {
            fail("unsupported operation: " + operation.op);
        }
    }

    function run() {
        var recipePath = $.getenv("PUPPETLOOM_PSD_REPAIR_RECIPE");
        var outputPath = $.getenv("PUPPETLOOM_PSD_REPAIR_OUTPUT");
        if (!recipePath || !outputPath) fail("missing PUPPETLOOM_PSD_REPAIR_RECIPE or PUPPETLOOM_PSD_REPAIR_OUTPUT." );
        var outputFile = new File(outputPath);
        if (outputFile.exists) fail("output already exists; refusing to overwrite: " + outputPath);
        var recipe = readRecipe(recipePath);
        var opened = [];
        var previousDialogs = app.displayDialogs;
        var target;
        var log = [];
        try {
            app.displayDialogs = DialogModes.NO;
            target = openDocument(recipe.basePsd, opened);
            for (var index = 0; index < recipe.operations.length; index += 1) {
                var details;
                try { details = perform(target, recipe, recipe.operations[index], opened); }
                catch (operationError) { fail("operation #" + index + " (" + recipe.operations[index].op + ") failed: " + operationError.message); }
                var logEntry = { index: index, op: recipe.operations[index].op, status: "completed" };
                if (details) logEntry.details = details;
                log.push(logEntry);
            }
            app.activeDocument = target;
            var saveOptions = new PhotoshopSaveOptions();
            saveOptions.layers = true;
            saveOptions.embedColorProfile = true;
            saveOptions.alphaChannels = true;
            saveOptions.annotations = true;
            target.saveAs(outputFile, saveOptions, true, Extension.LOWERCASE);
            var result = {
                ok: true,
                engine: "photoshop-com-extendscript",
                photoshopVersion: app.version,
                output: outputPath,
                canvas: { width: target.width.as("px"), height: target.height.as("px") },
                topLevelLayerCount: target.layers.length,
                operations: log
            };
            target.close(SaveOptions.DONOTSAVECHANGES);
            opened.pop();
            app.displayDialogs = previousDialogs;
            return jsonStringify(result);
        } catch (error) {
            for (var closeIndex = opened.length - 1; closeIndex >= 0; closeIndex -= 1) {
                try { opened[closeIndex].close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) {}
            }
            app.displayDialogs = previousDialogs;
            throw error;
        }
    }

    return run();
}());
