import { useState } from 'react';
import { Bell, Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Label } from './ui/label';
import { toast } from 'sonner';

interface Alert {
  id: string;
  metric: string;
  pair: string;
  operator: string;
  value: number;
  active: boolean;
}

interface AlertsPanelProps {
  onAddAlert: (alert: Omit<Alert, 'id' | 'active'>) => void;
}

export const AlertsPanel = ({ onAddAlert }: AlertsPanelProps) => {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [metric, setMetric] = useState('zscore');
  const [pair, setPair] = useState('BTCUSDT-ETHUSDT');
  const [operator, setOperator] = useState('>');
  const [value, setValue] = useState('2');

  // Update pair placeholder when metric changes
  const handleMetricChange = (newMetric: string) => {
    setMetric(newMetric);
    if (newMetric === 'price' && pair.includes('-')) {
      setPair('BTCUSDT');
    } else if (newMetric !== 'price' && !pair.includes('-')) {
      setPair('BTCUSDT-ETHUSDT');
    }
  };

  const handleAddAlert = () => {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      toast.error('Invalid value - please enter a valid number');
      return;
    }

    // Validate pair format for comparison metrics
    if (['zscore', 'spread', 'correlation'].includes(metric)) {
      if (!pair.includes('-')) {
        toast.error('Pair format should be SYMBOL1-SYMBOL2 (e.g., BTCUSDT-ETHUSDT) for comparison metrics');
        return;
      }
    }

    const newAlert: Alert = {
      id: `alert-${Date.now()}`,
      metric,
      pair,
      operator,
      value: numValue,
      active: true,
    };

    setAlerts([...alerts, newAlert]);
    onAddAlert({ metric, pair, operator, value: numValue });
    
    // Don't show toast here - parent component will handle it
  };

  const handleRemoveAlert = (id: string) => {
    setAlerts(alerts.filter(a => a.id !== id));
    toast.info('Alert removed');
  };

  return (
    <Card className="bg-gradient-card border-border/50 shadow-card">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Bell className="w-5 h-5" />
          Alerts
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Create Alert Form */}
        <div className="space-y-3 p-3 rounded-lg bg-secondary/30 border border-border/50">
          <div className="space-y-2">
            <Label className="text-xs">Metric</Label>
            <Select value={metric} onValueChange={handleMetricChange}>
              <SelectTrigger className="h-8 bg-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zscore">Z-Score (requires comparison mode)</SelectItem>
                <SelectItem value="spread">Spread (requires comparison mode)</SelectItem>
                <SelectItem value="correlation">Correlation (requires comparison mode)</SelectItem>
                <SelectItem value="price">Price (single symbol)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">
              {metric === 'price' ? 'Symbol' : 'Pair (SYMBOL1-SYMBOL2)'}
            </Label>
            <Input
              value={pair}
              onChange={(e) => setPair(e.target.value)}
              className="h-8 bg-input text-sm"
              placeholder={metric === 'price' ? 'BTCUSDT' : 'BTCUSDT-ETHUSDT'}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <Label className="text-xs">Operator</Label>
              <Select value={operator} onValueChange={setOperator}>
                <SelectTrigger className="h-8 bg-input">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value=">">{'>'}</SelectItem>
                  <SelectItem value="<">{'<'}</SelectItem>
                  <SelectItem value=">=">{'≥'}</SelectItem>
                  <SelectItem value="<=">{'≤'}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Value</Label>
              <Input
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="h-8 bg-input text-sm font-mono"
                step="0.1"
              />
            </div>
          </div>

          <Button
            onClick={handleAddAlert}
            size="sm"
            className="w-full bg-primary hover:bg-primary/90"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Alert
          </Button>
        </div>

        {/* Active Alerts List */}
        <div className="space-y-2">
          {alerts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No active alerts
            </p>
          ) : (
            alerts.map(alert => (
              <div
                key={alert.id}
                className="flex items-center justify-between p-2 rounded-md bg-secondary/50 text-sm"
              >
                <div className="flex-1">
                  <p className="font-medium">
                    {alert.metric} {alert.operator} {alert.value}
                  </p>
                  <p className="text-xs text-muted-foreground">{alert.pair}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemoveAlert(alert.id)}
                  className="h-8 w-8 p-0"
                >
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </div>
            ))
          )}
        </div>
        
        {/* Info Message */}
        <div className="text-xs text-muted-foreground bg-secondary/20 p-2 rounded-md border border-border/30">
          <p className="font-medium mb-1">💡 Alert Tips:</p>
          <ul className="space-y-1 ml-3">
            <li>• Z-Score, Spread, Correlation require comparison mode with 2 symbols</li>
            <li>• Price alerts work in single symbol mode</li>
            <li>• Alerts are checked in real-time as data streams</li>
            <li>• You'll receive toast notifications when alerts trigger</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
};
