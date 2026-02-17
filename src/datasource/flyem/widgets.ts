/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { JsonObject } from "#src/datasource/flyem/jsonschema.js";
import { getJsonSchemaProperties } from "#src/datasource/flyem/jsonschema.js";
import type {
  AnnotationReference,
  Annotation,
} from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import type { Borrowed } from "#src/util/disposable.js";
import type {
  AnnotationFacade,
  FlyEMAnnotation,
} from "#src/datasource/flyem/annotation.js";
import { defaultJsonSchema } from "#src/datasource/flyem/annotation.js";

const ANNOTATION_ROOT_ID = "annotation";

export function createTitleElement(title: string) {
  const element = document.createElement("div");
  element.textContent = title;
  return element;
}

export function createBasicElement(
  schema: JsonObject,
  id: string,
  value: any,
  readonly = false,
) {
  const element = document.createElement("div");

  const title: string = schema["title"] as string;

  if (title) {
    element.appendChild(document.createTextNode(title));
  }

  let valueElement: any;
  switch (schema["type"]) {
    case "number":
      valueElement = document.createElement("input");
      if (typeof value === "number") {
        valueElement.text = value;
      }
      break;
    case "string": {
      const optionList = schema["enum"];
      if (Array.isArray(optionList)) {
        valueElement = document.createElement("select");
        element.appendChild(valueElement);
        optionList.forEach((option) => {
          const optionElement = document.createElement("option");
          optionElement.text = option as string;
          optionElement.value = option as string;
          optionElement.disabled = readonly;
          valueElement.appendChild(optionElement);
        });
        if (value !== undefined) {
          valueElement.value = value;
        }
      } else {
        valueElement = document.createElement("input");
        valueElement.setAttribute("autocomplete", "off");
        if (typeof value === "string") {
          valueElement.value = value;
          valueElement.setAttribute("value", value);
        }
      }
      break;
    }
    case "boolean":
      valueElement = document.createElement("input");
      valueElement.type = "checkbox";
      if (typeof value === "boolean") {
        valueElement.checked = value;
      } else {
        // can be either 1 or '1'
        valueElement.checked = value == 1 ? true : false;
      }
      break;
    default:
      break;
  }

  if (valueElement) {
    valueElement.id = id;
    valueElement.readOnly = readonly;
    element.appendChild(valueElement);
  }

  return element;
}

function getElementId(parentId: string, prop: string) {
  return parentId + "/" + prop;
}

function createElement(
  schema: JsonObject,
  assigned: JsonObject,
  rootId: string,
  readonly = false,
): HTMLDivElement {
  const element = document.createElement("div");
  const root = getJsonSchemaProperties(schema, rootId);
  root.record = element;

  for (const node of root) {
    if (!node.isRoot()) {
      if (node.isLeaf()) {
        const value = node.getPropertyValue(assigned);
        const newElement = createBasicElement(
          node.properties!,
          node.fullName,
          value,
          readonly,
        );

        node.parentNode!.record!.appendChild(newElement);
      } else {
        const fieldset = document.createElement("fieldset");
        const legend = document.createElement("legend");

        legend.textContent = node.properties!.title;
        fieldset.appendChild(legend);
        node.record = fieldset;
        node.parentNode!.record!.appendChild(fieldset);
      }
    }
  }

  return element;
}

export function createAnnotationWidget(
  schema: JsonObject,
  assigned: JsonObject,
  readonly = false,
) {
  return createElement(schema, assigned, ANNOTATION_ROOT_ID, readonly);
}

export function getValueFromElement(id: string) {
  const element: any = document.getElementById(id);
  if (element) {
    if (element["type"] === "checkbox") {
      return element["checked"];
    } else {
      return element["value"];
    }
  }
}

export function getObjectFromWidget(
  schema: any,
  key: string,
  result: any,
  id: string,
) {
  if (schema.type === "object") {
    schema.required.forEach((prop: string) => {
      let subresult = result;
      if (key) {
        if (typeof result[key] === "undefined") {
          result[key] = {};
        }

        subresult = result[key];
      }
      getObjectFromWidget(
        schema.properties[prop],
        prop,
        subresult,
        getElementId(id, prop),
      );
    });
  } else {
    result[key] = getValueFromElement(id);
  }
}

function setWidgetValue(widget: HTMLElement, value: any, id: string) {
  try {
    const element: any = widget.querySelector("#" + id);
    if (element) {
      if (element instanceof HTMLSelectElement) {
        element.value = value;
      }
    }
  } catch (e) {
    console.log(e);
  }
}

export function setWidgetFromObject(
  widget: HTMLElement,
  result: any,
  parentId: string,
) {
  Object.keys(result).forEach((key) => {
    if (result.hasOwnProperty(key)) {
      const currentId = getElementId(parentId, key);
      if (typeof result[key] === "object") {
        setWidgetFromObject(widget, result[key], currentId);
      } else {
        setWidgetValue(widget, result[key], currentId);
      }
    }
  });
}

export interface WidgetFactory {
  createWidget(assigned: JsonObject): HTMLDivElement | null;
}

export class AnnotationWidgetFactory implements WidgetFactory {
  widget: HTMLDivElement | null = null;
  createPostWidget: (() => any) | undefined;

  constructor(public schema: any) {}

  createWidget(assigned: JsonObject): HTMLDivElement | null {
    if (this.schema) {
      this.widget = createAnnotationWidget(this.schema, assigned);
      console.log(this.widget);
      if (this.widget) {
        if (this.createPostWidget) {
          this.widget.appendChild(this.createPostWidget());
        }
      }
    }

    return this.widget;
  }

  getObject(): any {
    const result = {};
    getObjectFromWidget(this.schema, "", result, ANNOTATION_ROOT_ID);

    return result;
  }

  setWidget(obj: any) {
    if (this.widget) {
      setWidgetFromObject(this.widget, obj, ANNOTATION_ROOT_ID);
    }
  }
}

export interface FrontendAnnotationSource {
  readonly: boolean | undefined;
  update: (reference: AnnotationReference, newAnnotation: Annotation) => void;
  commit: (reference: Borrowed<AnnotationReference>) => void;
}

export function makeAnnotationEditWidget(
  reference: AnnotationReference,
  schema: JsonObject | null | undefined,
  source: FrontendAnnotationSource,
  getFacade: (annotation: FlyEMAnnotation) => AnnotationFacade,
  getProp?: (annotation: FlyEMAnnotation) => { [key: string]: any },
  setProp?: (
    annotation: FlyEMAnnotation,
    prop: { [key: string]: any },
  ) => void,
) {
  const annotation = { ...reference.value! };

  if (
    annotation.type !== AnnotationType.POINT &&
    annotation.type !== AnnotationType.LINE &&
    annotation.type !== AnnotationType.ELLIPSOID
  ) {
    return null;
  }

  if (!schema) {
    schema = defaultJsonSchema;
  }

  const annotationRef = getFacade(annotation as FlyEMAnnotation);
  const prop = getProp
    ? getProp(annotation as FlyEMAnnotation)
    : annotationRef.prop;
  const widget = createAnnotationWidget(
    schema,
    prop ? { Prop: prop } : {},
    source.readonly,
  );

  const button = document.createElement("button");
  button.textContent = "update";
  button.onclick = () => {
    const result: any = {};
    getObjectFromWidget(schema, "", result, "annotation");
    const x = result["Prop"];
    if (setProp) {
      setProp(annotation as FlyEMAnnotation, x);
    } else {
      annotationRef.setProp(x);
    }

    annotationRef.update();

    source.update(reference, annotation);
    source.commit(reference);
  };

  widget.appendChild(button);
  return widget;
}

const jsonData = `
{
  "definitions": {},
  "type": "object",
  "required": [
    "Prop"
  ],
  "properties": {
    "Prop": {
      "$id": "#/properties/Prop",
      "type": "object",
      "title": "Properties",
      "required": [
        "comment",
        "type",
        "checked"
      ],
      "properties": {
        "comment": {
          "$id": "#/properties/Prop/properties/comment",
          "type": "string",
          "title": "Comment",
          "default": ""
        },
        "type": {
          "$id": "#/properties/Prop/properties/type",
          "type": "string",
          "title": "Type",
          "enum": ["Merge", "Split", "Other"]
        },
        "checked": {
          "$id": "#/properties/Prop/properties/checked",
          "type": "boolean",
          "title": "Checked"
        }
      }
    }
  }
}
`;

export const testSchema = JSON.parse(jsonData);
