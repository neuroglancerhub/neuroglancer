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

import {JsonObject, getJsonSchemaProperties, PropertyTreeNode} from 'neuroglancer/datasource/dvid/jsonschema';
import {proofreadingStats} from 'neuroglancer/datasource/dvid/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {AnnotationType, AnnotationReference, Annotation} from 'neuroglancer/annotation/index';
import {Borrowed} from 'neuroglancer/util/disposable';
import {DVIDAnnotation, DVIDPointAnnotation, getAnnotationDescription,defaultJsonSchema, DVIDPointAnnotationFacade, DVIDSphereAnnotation, DVIDSphereAnnotationFacade} from 'neuroglancer/datasource/dvid/utils';

const ANNOTATION_ROOT_ID = 'annotation';

export function createTitleElement(title: string)
{
  let element = document.createElement('div');
  element.textContent = title;
  return element;
}

export function createBasicElement(
  schema: JsonObject, id: string, value: any, readonly = false)
{
  let element = document.createElement('div');

  let title:string = schema['title'] as string;

  if (title) {
    element.appendChild(document.createTextNode(title));
  }
  
  let valueElement: any;
  switch (schema['type']) {
    case 'number':
      valueElement = document.createElement('input');
      if (typeof(value) === 'number') {
        valueElement.text = value;
      }
      break;
    case 'string':
      let optionList = schema['enum'];
      if (Array.isArray(optionList)) {
        valueElement = document.createElement('select');
        element.appendChild(valueElement);
        optionList.forEach(option => {
          let optionElement = document.createElement('option');
          optionElement.text = option as string;
          optionElement.value = option as string;
          optionElement.disabled = readonly;
          valueElement.appendChild(optionElement);
        });
        if (value !== undefined) {
          valueElement.value = value;
        }
      } else {
        valueElement = document.createElement('input');
        valueElement.setAttribute('autocomplete', "off");
        if (typeof(value) === 'string') {
          valueElement.value = value;
          valueElement.setAttribute('value', value);
          // console.log('value', value);
        }
      }
      break;
    case 'boolean':
      valueElement = document.createElement('input');
      valueElement.type = 'checkbox';
      if (typeof(value) === 'boolean') {
        valueElement.checked = value;
      } else { 
        //can be either 1 or '1'
        valueElement.checked = (value == 1) ? true : false;
      }
      break;
    default:
      break;
  }

  if (valueElement) {
    valueElement.id = id;
    valueElement.readOnly = readonly;
    element.appendChild(valueElement);
    // console.log(valueElement.outerHTML);
  }

  return element;
}


function getElementId(parentId: string, prop: string)
{
  return parentId + "/" + prop;
}

function createElement(
  schema: JsonObject, assigned: JsonObject, rootId: string, readonly = false): HTMLDivElement
{
  let element = document.createElement('div');
  let root: PropertyTreeNode = getJsonSchemaProperties(schema, rootId);
  root.record = element;

  for (let node of root) {
    if (!node.isRoot()) {
      // console.log('node properties', node.properties);
      if (node.isLeaf()) {
        let value = node.getPropertyValue(assigned);
        let newElement = createBasicElement(
          node.properties, node.fullName, value, readonly);

        node.parentNode.record!.appendChild(newElement);
        // console.log(node.parentNode.record.innerHTML)
      } else {
        let fieldset = document.createElement('fieldset');
        let legend = document.createElement('legend');
        
        legend.textContent = node.properties.title;
        fieldset.appendChild(legend);
        node.record = fieldset;
        node.parentNode.record!.appendChild(fieldset);
      }
    }
  }

  return element;
}

/*
function createElement(obj: any, id: string) : HTMLDivElement
{
  let element = document.createElement('div');

  if (obj.type === 'object') {
    let containerElement:any = element;
    
    if (typeof(obj.title) === 'string') {
      let fieldset = document.createElement('fieldset');
      let legend = document.createElement('legend');
      legend.textContent = obj.title;
      fieldset.appendChild(legend);
      containerElement = fieldset;
      element.appendChild(containerElement)
      // element.appendChild(createTitleElement(obj.title));
    }

    obj.required.forEach(
      (prop:string) => {
        let newId = getElementId(id, prop);
        let propObj = obj.properties[prop];
        let childElement = createElement(propObj, newId);
        if (childElement instanceof Element) {
          containerElement.appendChild(childElement);
        }
      }
    );
  } else {
    element.appendChild(createBasicElement(obj, id));
  }

  return element;
}
*/

function createTableElement(matrix: HTMLElement[][])
{
  let table = document.createElement('table');
  table.style.borderCollapse = 'collapse';
  table.style.borderSpacing = '0px';
  table.style.display = 'block';
  for (let row of matrix) {
    let tr = document.createElement('tr');
    for (let cell of row) {
      let td = document.createElement('td');
      td.appendChild(cell);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }

  return table;
}

export function createProofreadWidget(mergeFunc: (mergingJson: Array<string>) => Promise<any>, mergingJsonProvider: () => Array<string>, postUpload: () => void) {
  let proofreadElement = document.createElement('div');

  let row = [];

  let fieldset = document.createElement('fieldset');
  let legend = document.createElement('legend');
  legend.textContent = 'Proofread';
  fieldset.appendChild(legend);
  proofreadElement.appendChild(fieldset);

  const uploadButton = document.createElement('button');
  row.push(uploadButton);

  uploadButton.textContent = 'Merge';
  uploadButton.addEventListener('click', () => {
    let mergingJson = mergingJsonProvider();
    if (mergingJson.length > 1) {
      let merging = window.confirm('Do you want to merge the selected bodies now? It cannot be undone!');
      if (merging) {
        StatusMessage.showTemporaryMessage('Merging bodies: ' + mergingJson);
        mergeFunc(mergingJson).then(response => {
          StatusMessage.showTemporaryMessage('Merged: ' + JSON.stringify(response));
          postUpload();
        }
        ).catch(e => {
          throw e;
        }
        );
      }
    } else {
      StatusMessage.showTemporaryMessage('You need to select at least two bodies to merge.')
    }
  });

  let chartElement = document.createElement('pre');
  let updateChartElement = () => {
    chartElement.innerText = '|  #Bodies merged today: ' + String(proofreadingStats.numBodyMerged.value);
  }
  updateChartElement();
  proofreadingStats.numBodyMerged.changed.add(() => {
    updateChartElement();
  });
  // statElement.appendChild(chartElement);

  let tdStat = document.createElement('td');
  row.push(tdStat);

  tdStat.style.padding = '0px';
  tdStat.style.margin = '0px';
  tdStat.appendChild(chartElement);

  let layoutElement = createTableElement([row]);
  fieldset.appendChild(layoutElement);


  return proofreadElement;
}

export function createAnnotationWidget(schema: JsonObject, assigned: JsonObject, readonly = false)
{
  return createElement(schema, assigned, ANNOTATION_ROOT_ID, readonly);
}

export function getValueFromElement(id: string)
{
  let element:any = document.getElementById(id);
  if (element) {
    if (element['type'] === 'checkbox') {
      return element['checked'];
    } else {
      return element['value'];
    }
  }
}

export function getObjectFromWidget(
  schema: any, key: string, result: any, id: string)
{
  if (schema.type === 'object') {
    schema.required.forEach(
      (prop:string) => {
        let subresult = result;
        if (key) {
          if (typeof(result[key]) === 'undefined') {
            result[key] = {};
          }
          
          subresult = result[key];
        }
        getObjectFromWidget(
          schema.properties[prop], prop, subresult, getElementId(id, prop));
      }
    );
  } else {
    result[key] = getValueFromElement(id);
  }
}

function setWidgetValue(widget: HTMLElement, value: any, id: string)
{
  // let element:any = document.getElementById(id);
  try {
    let element: any = widget.querySelector('#' + id);
    if (element) {
      if (element instanceof HTMLSelectElement) {
        element.value = value;
      }
    }
  } catch(e) {
    console.log(e);
  }
}

export function setWidgetFromObject(widget: HTMLElement, result: any, parentId: string)
{
  Object.keys(result).forEach(
    key => {
      if (result.hasOwnProperty(key)) {
        let currentId = getElementId(parentId, key);
        if (typeof(result[key]) === 'object') {
          setWidgetFromObject(widget, result[key], currentId);
        } else {
          setWidgetValue(widget, result[key], currentId);
        }
      }
    }
  );
}

export interface WidgetFactory {
  createWidget(assigned: JsonObject): HTMLDivElement|null;
}

export class AnnotationWidgetFactory implements WidgetFactory 
{
  widget: HTMLDivElement|null = null;
  createPostWidget: ()=>any;

  constructor(public schema: any) {
  }

  createWidget(assigned: JsonObject): HTMLDivElement|null {
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
    let result = {};
    getObjectFromWidget(this.schema, '', result, ANNOTATION_ROOT_ID);

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
};


export function makeAnnotationEditWidget(reference: AnnotationReference, schema: JsonObject|null|undefined, source: FrontendAnnotationSource) {
  const annotation = {...reference.value!};

  if (annotation.type !== AnnotationType.POINT && annotation.type !== AnnotationType.SPHERE &&
  annotation.type !== AnnotationType.LINE) {
    return null;
  }

  if (!schema || annotation.type !== AnnotationType.POINT) {
    schema = defaultJsonSchema;
  }

  const prop = (<DVIDPointAnnotation>(annotation)).prop;
  let widget = createAnnotationWidget(schema, { 'Prop': prop }, source.readonly);

  // console.log(annotation);
  // setWidgetFromObject(widget, annotation.property, 'annotation\\Prop');
  let button = document.createElement('button');
  button.textContent = 'update';
  button.onclick = () => {
    let result: any = {};
    getObjectFromWidget(schema, '', result, 'annotation');
    // alert(JSON.stringify(result));
    const x = result['Prop'];
    if (annotation.type === AnnotationType.POINT) {
      let newAnnotation = <DVIDPointAnnotation>annotation;
      let annotFac = new DVIDPointAnnotationFacade(newAnnotation);
      if (x.checked) {
        x.checked = annotFac.getBooleanProperty(x.checked);
      }
      annotFac.prop = {...newAnnotation.prop, ...x};
    } else {
      let newAnnotation = <DVIDSphereAnnotation>annotation;
      let annotFac = new DVIDSphereAnnotationFacade(newAnnotation);
      if (x) {
        annotFac.prop = newAnnotation.prop ? {...newAnnotation.prop, ...x} : x;
      }
    }
    // let newAnnotation: DVIDPointAnnotation = <DVIDPointAnnotation>(annotation);

    annotation.description = getAnnotationDescription(<DVIDAnnotation>annotation);
    source.update(reference, annotation);
    source.commit(reference);

  };
  
  widget.appendChild(button);
  return widget;
}

let jsonData = `
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