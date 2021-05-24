/**
 * @license
 * Copyright 2016 Google Inc.
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

import './viewer.css';
import 'neuroglancer/noselect.css';

import svg_controls_alt from 'ikonate/icons/controls-alt.svg';
import svg_layers from 'ikonate/icons/layers.svg';
import svg_list from 'ikonate/icons/list.svg';
import debounce from 'lodash/debounce';
import {CapacitySpecification, ChunkManager, ChunkQueueManager, FrameNumberCounter} from 'neuroglancer/chunk_manager/frontend';
import {makeCoordinateSpace, TrackableCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {defaultCredentialsManager} from 'neuroglancer/credentials_provider/default_manager';
import {InputEventBindings as DataPanelInputEventBindings} from 'neuroglancer/data_panel_layout';
import {DataSourceProviderRegistry} from 'neuroglancer/datasource';
import {getDefaultDataSourceProvider} from 'neuroglancer/datasource/default_provider';
import {DisplayContext, TrackableWindowedViewport} from 'neuroglancer/display_context';
import {HelpPanelState, InputEventBindingHelpDialog} from 'neuroglancer/help/input_event_bindings';
import {addNewLayer, LayerManager, LayerSelectedValues, MouseSelectionState, SelectedLayerState, TopLevelLayerListSpecification, TrackableDataSelectionState} from 'neuroglancer/layer';
import {RootLayoutContainer} from 'neuroglancer/layer_groups_layout';
import {DisplayPose, NavigationState, OrientationState, Position, TrackableCrossSectionZoom, TrackableDepthRange, TrackableDisplayDimensions, TrackableProjectionZoom, TrackableRelativeDisplayScales, WatchableDisplayDimensionRenderInfo} from 'neuroglancer/navigation_state';
import {overlaysOpen} from 'neuroglancer/overlay';
import {allRenderLayerRoles, RenderLayerRole} from 'neuroglancer/renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {ElementVisibilityFromTrackableBoolean, TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {makeDerivedWatchableValue, observeWatchable, TrackableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {ContextMenu} from 'neuroglancer/ui/context_menu';
import {LayerArchiveCountWidget, LayerListPanel, LayerListPanelState} from 'neuroglancer/ui/layer_list_panel';
import {LayerSidePanelManager} from 'neuroglancer/ui/layer_side_panel';
import {setupPositionDropHandlers} from 'neuroglancer/ui/position_drag_and_drop';
import {SelectionDetailsPanel} from 'neuroglancer/ui/selection_details';
import {SidePanelManager} from 'neuroglancer/ui/side_panel';
import {StateEditorDialog} from 'neuroglancer/ui/state_editor';
import {StatisticsDisplayState, StatisticsPanel} from 'neuroglancer/ui/statistics';
import {AutomaticallyFocusedElement} from 'neuroglancer/util/automatic_focus';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {registerActionListener} from 'neuroglancer/util/event_action_map';
import {vec3} from 'neuroglancer/util/geom';
import {parseFixedLengthArray, verifyFinitePositiveFloat, verifyObject, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import {EventActionMap, KeyboardEventBinder} from 'neuroglancer/util/keyboard_bindings';
import {NullarySignal} from 'neuroglancer/util/signal';
import {CompoundTrackable, optionallyRestoreFromJsonMember} from 'neuroglancer/util/trackable';
import {ViewerState, VisibilityPrioritySpecification} from 'neuroglancer/viewer_state';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {GL} from 'neuroglancer/webgl/context';
import {AnnotationToolStatusWidget} from 'neuroglancer/widget/annotation_tool_status';
import {CheckboxIcon} from 'neuroglancer/widget/checkbox_icon';
import {makeIcon} from 'neuroglancer/widget/icon';
import {NumberInputWidget} from 'neuroglancer/widget/number_input_widget';
import {MousePositionWidget, PositionWidget} from 'neuroglancer/widget/position_widget';
import {TrackableScaleBarOptions} from 'neuroglancer/widget/scale_bar';
import {RPC} from 'neuroglancer/worker_rpc';
import { StateShare, stateShareEnabled } from './datasource/state_share';
import {setClipboard} from 'neuroglancer/util/clipboard';
import {encodeFragment} from 'neuroglancer/ui/url_hash_binding';
import {makeCopyButton} from 'neuroglancer/widget/copy_button';

declare var NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS: any

declare var NEUROGLANCER_CREDIT_LINK: {
  url: string,
  text: string,
}|undefined;

export class DataManagementContext extends RefCounted {
  worker: Worker;
  chunkQueueManager: ChunkQueueManager;
  chunkManager: ChunkManager;

  get rpc(): RPC {
    return this.chunkQueueManager.rpc!;
  }

  constructor(
      public gl: GL, public frameNumberCounter: FrameNumberCounter, bundleRoot: string = '') {
    super();
    const chunk_worker_url = bundleRoot + 'chunk_worker.bundle.js';
    this.worker = new Worker(chunk_worker_url);
    this.chunkQueueManager = this.registerDisposer(
        new ChunkQueueManager(new RPC(this.worker), this.gl, this.frameNumberCounter, {
          gpuMemory: new CapacitySpecification({defaultItemLimit: 1e6, defaultSizeLimit: 1e9}),
          systemMemory: new CapacitySpecification({defaultItemLimit: 1e7, defaultSizeLimit: 2e9}),
          download: new CapacitySpecification(
              {defaultItemLimit: 32, defaultSizeLimit: Number.POSITIVE_INFINITY}),
          compute: new CapacitySpecification({defaultItemLimit: 128, defaultSizeLimit: 5e8}),
        }));
    this.chunkQueueManager.registerDisposer(() => this.worker.terminate());
    this.chunkManager = this.registerDisposer(new ChunkManager(this.chunkQueueManager));
  }
}

export class InputEventBindings extends DataPanelInputEventBindings {
  global = new EventActionMap();
}

const viewerUiControlOptionKeys: (keyof ViewerUIControlConfiguration)[] = [
  'showHelpButton',
  'showEditStateButton',
  'showLayerListPanelButton',
  'showSelectionPanelButton',
  'showLayerSidePanelButton',
  'showLayerPanel',
  'showLocation',
  'showLayerHoverValues',
  'showAnnotationToolStatus',
];

const viewerOptionKeys: (keyof ViewerUIOptions)[] =
    ['showUIControls', 'showPanelBorders', ...viewerUiControlOptionKeys];

export class ViewerUIControlConfiguration {
  showHelpButton = new TrackableBoolean(true);
  showEditStateButton = new TrackableBoolean(true);
  showLayerListPanelButton = new TrackableBoolean(true);
  showSelectionPanelButton = new TrackableBoolean(true);
  showLayerSidePanelButton = new TrackableBoolean(true);
  showLayerPanel = new TrackableBoolean(true);
  showLocation = new TrackableBoolean(true);
  showLayerHoverValues = new TrackableBoolean(true);
  showAnnotationToolStatus = new TrackableBoolean(true);
}

export class ViewerUIConfiguration extends ViewerUIControlConfiguration {
  /**
   * If set to false, all UI controls (controlled individually by the options below) are disabled.
   */
  showUIControls = new TrackableBoolean(true);
  showPanelBorders = new TrackableBoolean(true);
}

function setViewerUiConfiguration(
    config: ViewerUIConfiguration, options: Partial<ViewerUIOptions>) {
  for (const key of viewerOptionKeys) {
    const value = options[key];
    if (value !== undefined) {
      config[key].value = value;
    }
  }
}

interface ViewerUIOptions {
  showUIControls: boolean;
  showHelpButton: boolean;
  showEditStateButton: boolean;
  showLayerListPanelButton: boolean;
  showSelectionPanelButton: boolean;
  showLayerSidePanelButton: boolean;
  showLayerPanel: boolean;
  showLocation: boolean;
  showLayerHoverValues: boolean;
  showPanelBorders: boolean;
  showAnnotationToolStatus: boolean;
}

export interface ViewerOptions extends ViewerUIOptions, VisibilityPrioritySpecification {
  dataContext: Owned<DataManagementContext>;
  element: HTMLElement;
  dataSourceProvider: Borrowed<DataSourceProviderRegistry>;
  uiConfiguration: ViewerUIConfiguration;
  showLayerDialog: boolean;
  inputEventBindings: InputEventBindings;
  resetStateWhenEmpty: boolean;
  bundleRoot: string;
}

const defaultViewerOptions = 'undefined' !== typeof NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS ?
    NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS :
    {
      showLayerDialog: true,
      resetStateWhenEmpty: true,
    };

function makeViewerContextMenu(viewer: Viewer) {
  const menu = new ContextMenu();
  const {element} = menu;
  element.classList.add('neuroglancer-viewer-context-menu');
  const addLimitWidget = (label: string, limit: TrackableValue<number>) => {
    const widget = menu.registerDisposer(new NumberInputWidget(limit, {label}));
    widget.element.classList.add('neuroglancer-viewer-context-menu-limit-widget');
    element.appendChild(widget.element);
  };
  addLimitWidget('GPU memory limit', viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit);
  addLimitWidget('System memory limit', viewer.chunkQueueManager.capacities.systemMemory.sizeLimit);
  addLimitWidget(
      'Concurrent chunk requests', viewer.chunkQueueManager.capacities.download.itemLimit);

  const addCheckbox = (label: string, value: WatchableValueInterface<boolean>) => {
    const labelElement = document.createElement('label');
    labelElement.textContent = label;
    const checkbox = menu.registerDisposer(new TrackableBooleanCheckbox(value));
    labelElement.appendChild(checkbox.element);
    element.appendChild(labelElement);
  };
  addCheckbox('Show axis lines', viewer.showAxisLines);
  addCheckbox('Show scale bar', viewer.showScaleBar);
  addCheckbox('Show cross sections in 3-d', viewer.showPerspectiveSliceViews);
  addCheckbox('Show default annotations', viewer.showDefaultAnnotations);
  addCheckbox('Show chunk statistics', viewer.statisticsDisplayState.location.watchableVisible);
  addCheckbox('Wire frame rendering', viewer.wireFrame);
  addCheckbox('Enable prefetching', viewer.chunkQueueManager.enablePrefetch);
  return menu;
}

class TrackableViewerState extends CompoundTrackable {
  constructor(public viewer: Borrowed<Viewer>) {
    super();
    this.add('dimensions', viewer.coordinateSpace);
    this.add('relativeDisplayScales', viewer.relativeDisplayScales);
    this.add('displayDimensions', viewer.displayDimensions);
    this.add('position', viewer.position);
    this.add('crossSectionOrientation', viewer.crossSectionOrientation);
    this.add('crossSectionScale', viewer.crossSectionScale);
    this.add('crossSectionDepth', viewer.crossSectionDepthRange);
    this.add('projectionOrientation', viewer.projectionOrientation);
    this.add('projectionScale', viewer.projectionScale);
    this.add('projectionDepth', viewer.projectionDepthRange);
    this.add('layers', viewer.layerSpecification);
    this.add('showAxisLines', viewer.showAxisLines);
    this.add('wireFrame', viewer.wireFrame);
    this.add('showScaleBar', viewer.showScaleBar);
    this.add('showDefaultAnnotations', viewer.showDefaultAnnotations);

    this.add('showSlices', viewer.showPerspectiveSliceViews);
    this.add('gpuMemoryLimit', viewer.dataContext.chunkQueueManager.capacities.gpuMemory.sizeLimit);
    this.add('prefetch', viewer.dataContext.chunkQueueManager.enablePrefetch);
    this.add(
        'systemMemoryLimit',
        viewer.dataContext.chunkQueueManager.capacities.systemMemory.sizeLimit);
    this.add(
        'concurrentDownloads', viewer.dataContext.chunkQueueManager.capacities.download.itemLimit);
    this.add('selectedLayer', viewer.selectedLayer);
    this.add('crossSectionBackgroundColor', viewer.crossSectionBackgroundColor);
    this.add('projectionBackgroundColor', viewer.perspectiveViewBackgroundColor);
    this.add('layout', viewer.layout);
    this.add('statistics', viewer.statisticsDisplayState);
    this.add('helpPanel', viewer.helpPanelState);
    this.add('selection', viewer.selectionDetailsState);
    this.add('layerListPanel', viewer.layerListPanelState);
    this.add('partialViewport', viewer.partialViewport);
    this.add('selectedStateServer', viewer.selectedStateServer);
  }

  restoreState(obj: any) {
    const {viewer} = this;
    super.restoreState(obj);
    // Handle legacy properties
    verifyOptionalObjectProperty(obj, 'navigation', navObj => {
      verifyObject(navObj);
      verifyOptionalObjectProperty(navObj, 'pose', poseObj => {
        verifyObject(poseObj);
        verifyOptionalObjectProperty(poseObj, 'position', positionObj => {
          verifyObject(positionObj);
          optionallyRestoreFromJsonMember(positionObj, 'voxelCoordinates', viewer.position);
          verifyOptionalObjectProperty(positionObj, 'voxelSize', voxelSizeObj => {
            // Handle legacy voxelSize representation
            const voxelSize =
                parseFixedLengthArray(new Float64Array(3), voxelSizeObj, verifyFinitePositiveFloat);
            for (let i = 0; i < 3; ++i) {
              voxelSize[i] *= 1e-9;
            }
            viewer.coordinateSpace.value = makeCoordinateSpace({
              valid: false,
              names: ['x', 'y', 'z'],
              units: ['m', 'm', 'm'],
              scales: voxelSize,
            });
          });
        });
        optionallyRestoreFromJsonMember(poseObj, 'orientation', viewer.crossSectionOrientation);
      });
      optionallyRestoreFromJsonMember(
          navObj, 'zoomFactor', viewer.crossSectionScale.legacyJsonView);
    });
    optionallyRestoreFromJsonMember(obj, 'perspectiveOrientation', viewer.projectionOrientation);
    optionallyRestoreFromJsonMember(obj, 'perspectiveZoom', viewer.projectionScale.legacyJsonView);
    optionallyRestoreFromJsonMember(
        obj, 'perspectiveViewBackgroundColor', viewer.perspectiveViewBackgroundColor);
  }
}

export const globalViewerConfig = {
  expectingExternalUI: false
};

export class Viewer extends RefCounted implements ViewerState {
  coordinateSpace = new TrackableCoordinateSpace();
  position = this.registerDisposer(new Position(this.coordinateSpace));
  relativeDisplayScales =
      this.registerDisposer(new TrackableRelativeDisplayScales(this.coordinateSpace));
  displayDimensions = this.registerDisposer(new TrackableDisplayDimensions(this.coordinateSpace));
  displayDimensionRenderInfo = this.registerDisposer(new WatchableDisplayDimensionRenderInfo(
      this.relativeDisplayScales.addRef(), this.displayDimensions.addRef()));
  crossSectionOrientation = this.registerDisposer(new OrientationState());
  crossSectionScale = this.registerDisposer(
      new TrackableCrossSectionZoom(this.displayDimensionRenderInfo.addRef()));
  projectionOrientation = this.registerDisposer(new OrientationState());
  crossSectionDepthRange =
      this.registerDisposer(new TrackableDepthRange(-10, this.displayDimensionRenderInfo));
  projectionDepthRange =
      this.registerDisposer(new TrackableDepthRange(-50, this.displayDimensionRenderInfo));
  projectionScale =
      this.registerDisposer(new TrackableProjectionZoom(this.displayDimensionRenderInfo.addRef()));
  navigationState = this.registerDisposer(new NavigationState(
      new DisplayPose(
          this.position.addRef(), this.displayDimensionRenderInfo.addRef(),
          this.crossSectionOrientation.addRef()),
      this.crossSectionScale.addRef(), this.crossSectionDepthRange.addRef()));
  perspectiveNavigationState = this.registerDisposer(new NavigationState(
      new DisplayPose(
          this.position.addRef(), this.displayDimensionRenderInfo.addRef(),
          this.projectionOrientation.addRef()),
      this.projectionScale.addRef(), this.projectionDepthRange.addRef()));
  mouseState = new MouseSelectionState();
  layerManager = this.registerDisposer(new LayerManager());
  selectedLayer = this.registerDisposer(new SelectedLayerState(this.layerManager.addRef()));
  showAxisLines = new TrackableBoolean(true, true);
  wireFrame = new TrackableBoolean(false, false);
  showScaleBar = new TrackableBoolean(true, true);
  showPerspectiveSliceViews = new TrackableBoolean(true, true);
  visibleLayerRoles = allRenderLayerRoles();
  showDefaultAnnotations = new TrackableBoolean(true, true);
  crossSectionBackgroundColor = new TrackableRGB(vec3.fromValues(0.5, 0.5, 0.5));
  perspectiveViewBackgroundColor = new TrackableRGB(vec3.fromValues(0, 0, 0));
  scaleBarOptions = new TrackableScaleBarOptions();
  partialViewport = new TrackableWindowedViewport();
  contextMenu: ContextMenu;
  statisticsDisplayState = new StatisticsDisplayState();
  helpPanelState = new HelpPanelState();
  layerSelectedValues =
      this.registerDisposer(new LayerSelectedValues(this.layerManager, this.mouseState));
  selectionDetailsState = this.registerDisposer(
      new TrackableDataSelectionState(this.coordinateSpace, this.layerSelectedValues));
  selectedStateServer = new TrackableValue<string>('', verifyString);
  layerListPanelState = new LayerListPanelState();

  resetInitiated = new NullarySignal();

  get chunkManager() {
    return this.dataContext.chunkManager;
  }
  get chunkQueueManager() {
    return this.dataContext.chunkQueueManager;
  }

  layerSpecification: TopLevelLayerListSpecification;
  layout: RootLayoutContainer;
  sidePanelManager: SidePanelManager;

  state: TrackableViewerState;

  dataContext: Owned<DataManagementContext>;
  visibility: WatchableVisibilityPriority;
  inputEventBindings: InputEventBindings;
  element: HTMLElement;
  dataSourceProvider: Borrowed<DataSourceProviderRegistry>;

  uiConfiguration: ViewerUIConfiguration;
  makeUrlFromState = (state: {[key: string]: any}) => {
    if (!globalViewerConfig.expectingExternalUI) {
      return window.location.toString();
    } else {
      return '/#!' + encodeFragment(JSON.stringify(state));
    }
  };

  get expectingExternalUI() {
    return globalViewerConfig.expectingExternalUI;
  }

  set expectingExternalUI(on) {
    globalViewerConfig.expectingExternalUI = on;
  }

  private makeUiControlVisibilityState(key: keyof ViewerUIOptions) {
    const showUIControls = this.uiConfiguration.showUIControls;
    const option = this.uiConfiguration[key];
    return this.registerDisposer(
        makeDerivedWatchableValue((a, b) => a && b, showUIControls, option));
  }

  /**
   * Logical and of each of the above values with the value of showUIControls.
   */
  uiControlVisibility:
      {[key in keyof ViewerUIControlConfiguration]: WatchableValueInterface<boolean>} = <any>{};

  showLayerDialog: boolean;
  resetStateWhenEmpty: boolean;

  get inputEventMap() {
    return this.inputEventBindings.global;
  }

  visible = true;
  closeSelectionTab?: () => void;

  constructor(public display: DisplayContext, options: Partial<ViewerOptions> = {}) {
    super();

    const {
      dataContext = new DataManagementContext(display.gl, display, options.bundleRoot),
      visibility = new WatchableVisibilityPriority(WatchableVisibilityPriority.VISIBLE),
      inputEventBindings = {
        global: new EventActionMap(),
        sliceView: new EventActionMap(),
        perspectiveView: new EventActionMap(),
      },
      element = display.makeCanvasOverlayElement(),
      dataSourceProvider =
          getDefaultDataSourceProvider({credentialsManager: defaultCredentialsManager}),
      uiConfiguration = new ViewerUIConfiguration(),
    } = options;
    this.visibility = visibility;
    this.inputEventBindings = inputEventBindings;
    this.element = element;
    this.dataSourceProvider = dataSourceProvider;
    this.uiConfiguration = uiConfiguration;

    this.registerDisposer(observeWatchable(value => {
      this.display.applyWindowedViewportToElement(element, value);
    }, this.partialViewport));

    this.registerDisposer(() => removeFromParent(this.element));

    this.dataContext = this.registerDisposer(dataContext);

    setViewerUiConfiguration(uiConfiguration, options);

    const optionsWithDefaults = {...defaultViewerOptions, ...options};
    const {
      resetStateWhenEmpty,
      showLayerDialog,
    } = optionsWithDefaults;

    for (const key of viewerUiControlOptionKeys) {
      this.uiControlVisibility[key] = this.makeUiControlVisibilityState(key);
    }
    this.registerDisposer(this.uiConfiguration.showPanelBorders.changed.add(() => {
      this.updateShowBorders();
    }));

    this.showLayerDialog = showLayerDialog;
    this.resetStateWhenEmpty = resetStateWhenEmpty;

    this.layerSpecification = new TopLevelLayerListSpecification(
        this.display, this.dataSourceProvider, this.layerManager, this.chunkManager,
        this.selectionDetailsState, this.selectedLayer, this.navigationState.coordinateSpace,
        this.navigationState.pose.position);

    this.registerDisposer(display.updateStarted.add(() => {
      this.onUpdateDisplay();
    }));

    this.showDefaultAnnotations.changed.add(() => {
      if (this.showDefaultAnnotations.value) {
        this.visibleLayerRoles.add(RenderLayerRole.DEFAULT_ANNOTATION);
      } else {
        this.visibleLayerRoles.delete(RenderLayerRole.DEFAULT_ANNOTATION);
      }
    });

    this.registerDisposer(this.navigationState.changed.add(() => {
      this.handleNavigationStateChanged();
    }));

    // Debounce this call to ensure that a transient state does not result in the layer dialog being
    // shown.
    const maybeResetState = this.registerCancellable(debounce(() => {
      if (!this.wasDisposed && this.layerManager.managedLayers.length === 0 &&
          this.resetStateWhenEmpty) {
        // No layers, reset state.
        this.navigationState.reset();
        this.perspectiveNavigationState.pose.orientation.reset();
        this.perspectiveNavigationState.zoomFactor.reset();
        this.resetInitiated.dispatch();
        if (!overlaysOpen && this.showLayerDialog && this.visibility.visible) {
          addNewLayer(this.layerSpecification, this.selectedLayer);
        }
      }
    }));
    this.layerManager.layersChanged.add(maybeResetState);
    maybeResetState();

    this.registerDisposer(this.dataContext.chunkQueueManager.visibleChunksChanged.add(() => {
      this.layerSelectedValues.handleLayerChange();
    }));

    this.registerDisposer(this.dataContext.chunkQueueManager.visibleChunksChanged.add(() => {
      if (this.visible) {
        display.scheduleRedraw();
      }
    }));

    this.makeUI();
    this.updateShowBorders();


    this.registerActionListeners();
    this.registerEventActionBindings();

    this.registerDisposer(setupPositionDropHandlers(element, this.navigationState.position));

    this.state = new TrackableViewerState(this);
  }

  private updateShowBorders() {
    const {element} = this;
    const className = 'neuroglancer-show-panel-borders';
    if (this.uiConfiguration.showPanelBorders.value) {
      element.classList.add(className);
    } else {
      element.classList.remove(className);
    }
  }

  private makeUI() {
    const gridContainer = this.element;
    gridContainer.classList.add('neuroglancer-viewer');
    gridContainer.classList.add('neuroglancer-noselect');
    gridContainer.style.display = 'flex';
    gridContainer.style.flexDirection = 'column';

    const topRow = document.createElement('div');
    topRow.title = 'Right click for settings';
    topRow.classList.add('neuroglancer-viewer-top-row');
    const contextMenu = this.contextMenu = this.registerDisposer(makeViewerContextMenu(this));
    contextMenu.registerParent(topRow);
    topRow.style.display = 'flex';
    topRow.style.flexDirection = 'row';
    topRow.style.alignItems = 'stretch';

    const positionWidget = this.registerDisposer(new PositionWidget(
        this.navigationState.position, this.layerSpecification.coordinateSpaceCombiner));
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showLocation, positionWidget.element));
    topRow.appendChild(positionWidget.element);

    const mousePositionWidget = this.registerDisposer(new MousePositionWidget(
        document.createElement('div'), this.mouseState, this.navigationState.coordinateSpace));
    mousePositionWidget.element.style.flex = '1';
    mousePositionWidget.element.style.alignSelf = 'center';
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showLocation, mousePositionWidget.element));
    topRow.appendChild(mousePositionWidget.element);

    if (typeof NEUROGLANCER_CREDIT_LINK !== 'undefined') {
      const {url, text} = NEUROGLANCER_CREDIT_LINK!;
      const creditLink = document.createElement('a');
      creditLink.href = url;
      creditLink.textContent = text;
      creditLink.style.fontFamily = 'sans-serif';
      creditLink.style.color = 'yellow';
      creditLink.target = '_blank';
      topRow.appendChild(creditLink);
    }

    const annotationToolStatus =
        this.registerDisposer(new AnnotationToolStatusWidget(this.selectedLayer));
    topRow.appendChild(annotationToolStatus.element);
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showAnnotationToolStatus, annotationToolStatus.element));

    if (stateShareEnabled) {
      const stateShare = this.registerDisposer(new StateShare(this));
      topRow.appendChild(stateShare.element);
    }

    {
      const {layerListPanelState} = this;
      const button =
          this.registerDisposer(new CheckboxIcon(layerListPanelState.location.watchableVisible, {
            svg: svg_layers,
            backgroundScheme: 'dark',
            enableTitle: 'Show layer list panel',
            disableTitle: 'Hide layer list panel'
          }));
      button.element.insertAdjacentElement(
          'afterbegin',
          this.registerDisposer(new LayerArchiveCountWidget(this.layerManager)).element);
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showLayerListPanelButton, button.element));
      topRow.appendChild(button.element);
    }

    {
      const {selectionDetailsState} = this;
      const button =
          this.registerDisposer(new CheckboxIcon(selectionDetailsState.location.watchableVisible, {
            svg: svg_list,
            backgroundScheme: 'dark',
            enableTitle: 'Show selection details panel',
            disableTitle: 'Hide selection details panel'
          }));
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showSelectionPanelButton, button.element));
      topRow.appendChild(button.element);
    }

    {
      const {selectedLayer} = this;
      const button = this.registerDisposer(new CheckboxIcon(
          {
            get value() {
              return selectedLayer.visible;
            },
            set value(visible: boolean) {
              selectedLayer.visible = visible;
            },
            changed: selectedLayer.location.locationChanged,
          },
          {
            svg: svg_controls_alt,
            backgroundScheme: 'dark',
            enableTitle: 'Show layer side panel',
            disableTitle: 'Hide layer side panel'
          }));
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showLayerSidePanelButton, button.element));
      topRow.appendChild(button.element);
    }

    {
      const button = makeIcon({text: '{}', title: 'Edit JSON state'});
      this.registerEventListener(button, 'click', () => {
        this.editJsonState();
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showEditStateButton, button));
      topRow.appendChild(button);
    }

    {
      const button = makeCopyButton({
        title: 'Copy view URL to clipboard',
        onClick: () => {
          const result = setClipboard(this.makeUrlFromState(this.state.toJSON()));
          StatusMessage.showTemporaryMessage(
              result ? 'URL copied to clipboard' : 'Failed to copy URL to clipboard');
        }
      });
      topRow.appendChild(button);
    }

    {
      const {helpPanelState} = this;
      const button =
          this.registerDisposer(new CheckboxIcon(helpPanelState.location.watchableVisible, {
            text: '?',
            backgroundScheme: 'dark',
            enableTitle: 'Show help panel',
            disableTitle: 'Hide help panel'
          }));
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showHelpButton, button.element));
      topRow.appendChild(button.element);
    }

    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        makeDerivedWatchableValue(
            (...values: boolean[]) => values.reduce((a, b) => a || b, false),
            this.uiControlVisibility.showHelpButton,
            this.uiControlVisibility.showSelectionPanelButton,
            this.uiControlVisibility.showEditStateButton, this.uiControlVisibility.showLocation,
            this.uiControlVisibility.showAnnotationToolStatus),
        topRow));

    gridContainer.appendChild(topRow);

    this.layout = this.registerDisposer(new RootLayoutContainer(this, '4panel'));
    this.sidePanelManager = this.registerDisposer(
        new SidePanelManager(this.display, this.layout.element, this.visibility));
    this.registerDisposer(this.sidePanelManager.registerPanel({
      location: this.layerListPanelState.location,
      makePanel: () =>
          new LayerListPanel(this.sidePanelManager, this.layerSpecification, this.layerListPanelState),
    }));
    this.registerDisposer(
        new LayerSidePanelManager(this.sidePanelManager, this.selectedLayer.addRef()));
    this.registerDisposer(this.sidePanelManager.registerPanel({
      location: this.selectionDetailsState.location,
      makePanel: () => new SelectionDetailsPanel(
          this.sidePanelManager, this.selectionDetailsState, this.layerSpecification,
          this.selectedLayer),
    }));
    gridContainer.appendChild(this.sidePanelManager.element);

    this.closeSelectionTab = () => {
      for (const panel of this.sidePanelManager.registeredPanels) {
        if (panel.panel instanceof SelectionDetailsPanel) {
          panel.panel.close();
        }
      }
    };

    this.registerDisposer(this.sidePanelManager.registerPanel({
      location: this.statisticsDisplayState.location,
      makePanel: () => new StatisticsPanel(
          this.sidePanelManager, this.chunkQueueManager, this.statisticsDisplayState),
    }));

    this.registerDisposer(this.sidePanelManager.registerPanel({
      location: this.helpPanelState.location,
      makePanel: () => {
        const {inputEventBindings} = this;
        return new InputEventBindingHelpDialog(
            this.sidePanelManager,
            this.helpPanelState,
            [
              ['Global', inputEventBindings.global],
              ['Cross section view', inputEventBindings.sliceView],
              ['3-D projection view', inputEventBindings.perspectiveView]
            ],
        );
      },
    }));

    const updateVisibility = () => {
      const shouldBeVisible = this.visibility.visible;
      if (shouldBeVisible !== this.visible) {
        gridContainer.style.visibility = shouldBeVisible ? 'inherit' : 'hidden';
        this.visible = shouldBeVisible;
      }
    };
    updateVisibility();
    this.registerDisposer(this.visibility.changed.add(updateVisibility));
  }

  /**
   * Called once by the constructor to set up event handlers.
   */
  private registerEventActionBindings() {
    const {element} = this;
    this.registerDisposer(new KeyboardEventBinder(element, this.inputEventMap));
    this.registerDisposer(new AutomaticallyFocusedElement(element));
  }

  bindAction(action: string, handler: () => void) {
    this.registerDisposer(registerActionListener(this.element, action, handler));
  }

  bindCallback(action: string, callback: (self: any) => void) {
    const handler = () => {
      callback(this);
    };
    this.registerDisposer(registerActionListener(this.element, action, handler));
  }


  /**
   * Called once by the constructor to register the action listeners.
   */
  private registerActionListeners() {
    for (const action of ['recolor', 'clear-segments', ]) {
      this.bindAction(action, () => {
        this.layerManager.invokeAction(action);
        this.closeSelectionTab && this.closeSelectionTab();
      });
    }

    for (const action of ['select']) {
      this.bindAction(action, () => {
        this.mouseState.updateUnconditionally();
        this.layerManager.invokeAction(action);
      });
    }

    this.bindAction('help', () => this.toggleHelpPanel());

    for (let i = 1; i <= 9; ++i) {
      this.bindAction(`toggle-layer-${i}`, () => {
        const layerIndex = i - 1;
        const layers = this.layerManager.managedLayers;
        if (layerIndex < layers.length) {
          let layer = layers[layerIndex];
          layer.setVisible(!layer.visible);
        }
      });
      this.bindAction(`toggle-pick-layer-${i}`, () => {
        const layerIndex = i - 1;
        const layers = this.layerManager.managedLayers;
        if (layerIndex < layers.length) {
          let layer = layers[layerIndex];
          layer.pickEnabled = !layer.pickEnabled;
        }
      });
      this.bindAction(`select-layer-${i}`, () => {
        const layerIndex = i - 1;
        const layers = this.layerManager.managedLayers;
        if (layerIndex < layers.length) {
          const layer = layers[layerIndex];
          this.selectedLayer.layer = layer;
          this.selectedLayer.visible = true;
        }
      });
    }

    this.bindAction('annotate', () => {
      const selectedLayer = this.selectedLayer.layer;
      if (selectedLayer === undefined) {
        StatusMessage.showTemporaryMessage('The annotate command requires a layer to be selected.');
        return;
      }
      const userLayer = selectedLayer.layer;
      if (userLayer === null || userLayer.tool.value === undefined) {
        StatusMessage.showTemporaryMessage(`The selected layer (${
            JSON.stringify(selectedLayer.name)}) does not have an active annotation tool.`);
        return;
      }
      userLayer.tool.value.trigger(this.mouseState);
    });

    this.bindAction('toggle-axis-lines', () => this.showAxisLines.toggle());
    this.bindAction('toggle-scale-bar', () => this.showScaleBar.toggle());
    this.bindAction('toggle-default-annotations', () => this.showDefaultAnnotations.toggle());
    this.bindAction('toggle-show-slices', () => this.showPerspectiveSliceViews.toggle());
    this.bindAction('toggle-show-statistics', () => this.showStatistics());
  }

  toggleHelpPanel() {
    this.helpPanelState.location.visible = !this.helpPanelState.location.visible;
  }

  editJsonState() {
    new StateEditorDialog(this);
  }

  copyJsonStateToUrl() {
    setClipboard(this.makeUrlFromState(this.state.toJSON()));
  }

  showStatistics(value: boolean|undefined = undefined) {
    if (value === undefined) {
      value = !this.statisticsDisplayState.location.visible;
    }
    this.statisticsDisplayState.location.visible = value;
  }

  get gl() {
    return this.display.gl;
  }

  onUpdateDisplay() {
    if (this.visible) {
      this.dataContext.chunkQueueManager.chunkUpdateDeadline = null;
    }
  }

  private handleNavigationStateChanged() {
    if (this.visible) {
      let {chunkQueueManager} = this.dataContext;
      if (chunkQueueManager.chunkUpdateDeadline === null) {
        chunkQueueManager.chunkUpdateDeadline = Date.now() + 10;
      }
    }
  }
}
